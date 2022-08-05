require('lottie-web').loadAnimation({
  container: document.getElementById('custom-spinner'),
  renderer: 'svg',
  loop: true,
  autoplay: true,
  animationData: require('./assets/preload.json')
});
