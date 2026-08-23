import { useEffect, useRef, useState } from "react";
import { beatsToVexDuration, midiToVexKey, parseTimeSignature, splitIntoMeasures } from "./notationUtils";

function createStaveNotes(VF, entries, selectedIndex, onSelectRef) {
  return entries.map((entry) => {
    if (entry.rest) {
      const { duration, dotted } = beatsToVexDuration(entry.rest.durationBeats);
      const staveNote = new VF.StaveNote({ clef: "treble", keys: ["b/4"], duration: duration + "r" });
      if (dotted) VF.Dot.buildAndAttach([staveNote], { all: true });
      return { staveNote, attachSelection: () => {} };
    }
    const { note, index } = entry;
    const { key, accidental } = midiToVexKey(note.midi);
    const { duration, dotted } = beatsToVexDuration(note.durationBeats ?? note.beats);
    const staveNote = new VF.StaveNote({ clef: "treble", keys: [key], duration });

    if (accidental) staveNote.addModifier(new VF.Accidental(accidental), 0);
    if (dotted) VF.Dot.buildAndAttach([staveNote], { all: true });
    if (index === selectedIndex) staveNote.setStyle({ fillStyle: "#0b8077", strokeStyle: "#0b8077" });

    const attachSelection = () => {
      const element = staveNote.getSVGElement?.();
      if (!element) return;
      element.style.cursor = "pointer";
      element.setAttribute("role", "button");
      element.setAttribute("aria-label", "编辑第 " + (index + 1) + " 个音符");
      element.addEventListener("click", () => onSelectRef.current(index));
      element.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelectRef.current(index);
        }
      });
    };
    return { staveNote, attachSelection };
  });
}

export default function VexFlowScore({ notes, rests = [], timeSignature = "4/4", selectedIndex, onSelect }) {
  const hostRef = useRef(null);
  const onSelectRef = useRef(onSelect);
  const [renderError, setRenderError] = useState(false);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    let disposed = false;
    let resizeObserver;
    let renderVersion = 0;
    let renderFrame = null;
    let renderedWidth = 0;
    const host = hostRef.current;
    if (!host) return undefined;

    const render = async (requestedWidth) => {
      const currentVersion = ++renderVersion;
      try {
        const VF = await import("vexflow/bravura");
        if (disposed || currentVersion !== renderVersion || !host) return;

        const entries = [
          ...notes.map((note, index) => ({ note, index, startBeat: Number(note.startBeat ?? note.startTime) || 0 })),
          ...rests.map((rest) => ({ rest, startBeat: Number(rest.startBeat ?? rest.startTime) || 0 }))
        ].sort((left, right) => left.startBeat - right.startBeat);
        const measures = splitIntoMeasures(entries, timeSignature);
        const signature = parseTimeSignature(timeSignature);
        const width = Math.max(276, Math.floor(requestedWidth || host.clientWidth || 320));
        const measuresPerRow = width < 540 ? 1 : 2;
        const systemCount = Math.ceil(measures.length / measuresPerRow);
        const systemHeight = 138;
        const height = Math.max(154, systemCount * systemHeight + 28);
        const renderer = new VF.Renderer(host, VF.Renderer.Backends.SVG);
        renderer.resize(width, height);
        const context = renderer.getContext();
        const scoreWidth = width - 24;

        measures.forEach((measure, measureIndex) => {
          const row = Math.floor(measureIndex / measuresPerRow);
          const column = measureIndex % measuresPerRow;
          const measuresInRow = Math.min(measuresPerRow, measures.length - row * measuresPerRow);
          const staveWidth = scoreWidth / measuresInRow;
          const staveX = 12 + column * staveWidth;
          const staveY = 28 + row * systemHeight;
          const stave = new VF.Stave(staveX, staveY, staveWidth);

          if (measureIndex === 0) stave.addClef("treble").addTimeSignature(signature.value);
          stave.setContext(context).draw();
          if (!measure.length) return;
          const visualNotes = createStaveNotes(VF, measure, selectedIndex, onSelectRef);
          const voice = new VF.Voice({ num_beats: signature.numerator, beat_value: signature.denominator }).setStrict(false);
          voice.addTickables(visualNotes.map(({ staveNote }) => staveNote));
          new VF.Formatter().joinVoices([voice]).formatToStave([voice], stave, { paddingBetween: 8 });
          voice.draw(context, stave);
          visualNotes.forEach(({ attachSelection }) => attachSelection());
        });
        setRenderError(false);
      } catch (error) {
        console.error("VexFlow score render failed", error);
        if (!disposed) setRenderError(true);
      }
    };

    const scheduleRender = (nextWidth, force = false) => {
      const width = Math.max(276, Math.floor(nextWidth || host.clientWidth || 320));
      if (!force && width === renderedWidth) return;
      if (renderFrame) window.cancelAnimationFrame(renderFrame);
      renderFrame = window.requestAnimationFrame(() => {
        renderFrame = null;
        renderedWidth = width;
        host.replaceChildren();
        render(width);
      });
    };
    scheduleRender(host.clientWidth, true);
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver((entries) => scheduleRender(entries[0]?.contentRect.width));
      resizeObserver.observe(host);
    }

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      if (renderFrame) window.cancelAnimationFrame(renderFrame);
      host.replaceChildren();
    };
  }, [notes, rests, timeSignature, selectedIndex]);

  if (renderError) return <p className="score-render-fallback">五线谱暂时无法显示，请使用简谱继续检查旋律。</p>;
  return <div ref={hostRef} className="vexflow-score" aria-label="可点击编辑的五线谱" />;
}
