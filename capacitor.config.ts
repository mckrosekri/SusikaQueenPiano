import type { CapacitorConfig } from '@capacitor/cli';
const config: CapacitorConfig = { appId: 'com.lucas.afterbeat', appName: 'SusikaQueenPiano', webDir: 'dist', android: { backgroundColor: '#fffaf2' }, plugins: { SystemBars: { style: 'LIGHT',insetsHandling: 'native', initialViewportFitValueHint: 'cover' } } };
export default config;
