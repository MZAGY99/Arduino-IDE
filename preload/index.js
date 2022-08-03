require('@lottiefiles/lottie-player');
const player = document.querySelector('lottie-player');
player.addEventListener('rendered', () =>
  player.load(require('./assets/preload.json'))
);
