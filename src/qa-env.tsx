import './qa-env-mock';
import './lib/polyfills';
import { createRoot } from 'react-dom/client';
import './index.css';
import { initTheme } from './lib/theme-store';
import { OnboardingSetup } from './components/onboarding-setup';
import { ServerSettingsDialog } from './components/server-settings-dialog';
initTheme();
const q = new URLSearchParams(location.search);
const settings = { apiKey: '', secretKey: '', production: false, autoStart: true, caPath: '', caPasswd: '', httpsEnabled: false, agentHarnessEnabled: false };
createRoot(document.getElementById('root')!).render(q.get('view') === 'dialog'
    ? <ServerSettingsDialog settings={settings} status={null} busy={false} onSave={async () => {}} onClose={() => {}} />
    : <OnboardingSetup />);
