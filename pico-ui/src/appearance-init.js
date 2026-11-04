// Resolve before styles load so a light workspace never flashes dark.
try {
  const choice = localStorage.getItem('halo.theme.v1') || 'system';
  document.documentElement.dataset.theme = choice === 'light' || choice === 'dark'
    ? choice : matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.themePreference = choice;
} catch {
  document.documentElement.dataset.theme = 'dark';
}
