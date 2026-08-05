export default {
  // Sites exposes the Vite build output through the ASSETS binding.
  fetch(request, env) {
    return env.ASSETS.fetch(request);
  }
};
