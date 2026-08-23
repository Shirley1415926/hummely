# Third-Party Audio

## Playback code

| Component | Version | Source | Code license | How Hummely uses it | Local footprint |
| --- | --- | --- | --- | --- | --- |
| smplr | 1.0.0 | https://github.com/danigb/smplr | MIT | Dynamically imported only after a user presses a real sampled-instrument preview. The React UI talks only to `src/sampledInstrumentEngine.js`. | `node_modules/smplr` is about 1,032 KiB before Vite bundling. It is not in the initial application module. |

The MIT license applies to smplr code, not automatically to its sound sources. Keep the relevant copyright and license text when distributing the package.

## Verified sampled instruments

| UI name | smplr factory and source | Original sample source | Sample license | Attribution | Commercial use | Files used by this project | Processing and hosting | Size |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Piano (钢琴) | `SplendidGrandPiano` | https://github.com/sfzinstruments/SplendidGrandPiano | Public Domain (the repository identifies the AKAI Steinway sample set as public domain) | Not required | Allowed | Only pitch and velocity ranges requested by the current melody; no whole General MIDI bank | No source samples are copied, converted, cropped, or committed. smplr loads them on demand from its remote host and may reuse Browser CacheStorage. | Remote and variable by selected notes; no audio files are shipped in this repository or PWA precache. |
| Mallet (木琴) | `Mallet`, `Xylophone - Soft Mallets` | https://github.com/sgossner/VCSL | CC0 1.0 | Not required | Allowed | The named soft-xylophone mapping only | No source samples are copied, converted, cropped, or committed. smplr loads them on demand and may reuse Browser CacheStorage. | Remote and variable by selected notes; no audio files are shipped in this repository or PWA precache. |

## Runtime behavior

- Hummely never preloads sample audio on the recording/home screen and does not add remote sample files to `public/sw.js`.
- A single sampled instrument is loaded after a user-initiated playback request. A 15-second timeout or load error falls back to the existing local Web Audio synthesizer and tells the user.
- Browser transfer size is displayed only when the remote server exposes Performance Resource Timing. It can otherwise remain unavailable; it is never guessed.
- The built-in metronome uses generated, low-pass-filtered Web Audio sine tones. It contains no third-party audio asset.
- Before self-hosting any source samples under `public/audio/instruments/`, preserve each source license and validate the selected pitch/velocity files individually.
