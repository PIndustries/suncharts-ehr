(() => {
  const sheet = document.querySelector('.sheet');
  const label = document.querySelector('#cms-zoom-label');
  const minimum = 0.8;
  const maximum = 1.6;
  const step = 0.1;
  const stored = Number.parseFloat(sessionStorage.getItem('suncharts.cms1500.zoom'));
  let zoom = Number.isFinite(stored) ? stored : 1.25;

  function apply(next) {
    zoom = Math.max(minimum, Math.min(maximum, Math.round(next * 100) / 100));
    sheet.style.zoom = String(zoom);
    label.value = `${Math.round(zoom * 100)}%`;
    label.textContent = label.value;
    sessionStorage.setItem('suncharts.cms1500.zoom', String(zoom));
  }

  document.querySelector('#cms-zoom-out').addEventListener('click', () => apply(zoom - step));
  document.querySelector('#cms-zoom-in').addEventListener('click', () => apply(zoom + step));
  document.querySelector('#cms-fit-page').addEventListener('click', () => {
    const available = Math.max(320, window.innerWidth - 32);
    apply(Math.min(1, available / sheet.offsetWidth));
  });
  document.querySelector('#cms-print').addEventListener('click', () => window.print());
  apply(zoom);
})();
