let installPrompt = null;
const displayMode = matchMedia('(display-mode: standalone)');
const notify = () => dispatchEvent(new Event('srs-install-change'));

export const isInstalled = () => displayMode.matches || navigator.standalone === true;
export const canInstall = () => !!installPrompt && !isInstalled();

addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  notify();
});
addEventListener('appinstalled', () => { installPrompt = null; notify(); });
displayMode.addEventListener('change', notify);

export async function installApp() {
  if (!installPrompt) return;
  const prompt = installPrompt;
  installPrompt = null;
  notify();
  await prompt.prompt();
  await prompt.userChoice;
}

if ('serviceWorker' in navigator && window.isSecureContext) {
  // An update waits until the old app windows close, preserving unfinished edits.
  navigator.serviceWorker.register(new URL('../sw.js', import.meta.url), { updateViaCache: 'none' })
    .catch((error) => console.warn('Offline support unavailable:', error));
}
