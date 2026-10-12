import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import '@fontsource-variable/manrope';

const root = createRoot(document.getElementById('root')!);
if (import.meta.env.DEV && new URLSearchParams(location.search).get('qa') === 'gameplay') {
  void import('./dev/gameplay-fixture').then(({ gameplayFixtures }) => root.render(<StrictMode><App testSongs={gameplayFixtures()} /></StrictMode>));
} else root.render(<StrictMode><App /></StrictMode>);
