import { Activity, ArrowLeft, Music2, Sparkles, Vibrate, Volume2 } from 'lucide-react';
import type { Settings,NoteSkin } from '../types';

interface SettingsPanelProps {
  settings: Settings;
  skins: NoteSkin[];
  onChange: (settings: Settings) => void;
  onCalibration: () => void;
  onBack: () => void;
}

export function SettingsPanel({ settings, skins,onChange, onCalibration, onBack }: SettingsPanelProps) {
  return (
    <section className="settings-screen" aria-labelledby="settings-title">
      <header className="detail-bar"><button className="icon-button" onClick={onBack} aria-label="Back"><ArrowLeft aria-hidden="true" /></button><span>Settings</span><span /></header>
      <div className="page-heading"><p className="eyebrow">Performance setup</p><h1 id="settings-title">Tune your stage</h1><p>Make your tiles feel great. Tap them anywhere while they are on screen.</p></div>

      <div className="settings-list">
        <div className="setting-block"><div className="setting-title"><Sparkles/><div><strong>Note finish</strong><small>Earn Crimson at 88% on Hard, Silver at 90% on Expert.</small></div></div><div className="segmented" role="radiogroup" aria-label="Note finish">{(['ivory','crimson','silver'] as const).map(skin=><button key={skin} role="radio" aria-checked={settings.skin===skin} disabled={!skins.includes(skin)} onClick={()=>onChange({...settings,skin})}>{skin}{!skins.includes(skin)?' · Locked':''}</button>)}</div></div>
        <div className="setting-block">
          <div className="setting-title"><Sparkles aria-hidden="true" /><div><strong>Stage effects</strong><small>Visual energy and decorative motion</small></div></div>
          <div className="segmented" role="radiogroup" aria-label="Stage effects">
            {(['full', 'reduced', 'minimal'] as const).map((effect) => <button key={effect} role="radio" aria-checked={settings.effects === effect} onClick={() => onChange({ ...settings, effects: effect })}>{effect}</button>)}
          </div>
        </div>
        <label className="switch-row setting-block">
          <span><Vibrate aria-hidden="true" /><span><strong>Haptics</strong><small>Feel key hits on supported devices</small></span></span>
          <input type="checkbox" checked={settings.haptics} onChange={(event) => onChange({ ...settings, haptics: event.target.checked })} />
        </label>
        <label className="range-row setting-block">
          <span><Music2 aria-hidden="true" /><span><strong>Music volume</strong><small>{Math.round(settings.musicVolume * 100)}%</small></span></span>
          <input type="range" min={0} max={1} step={0.05} value={settings.musicVolume} onChange={(event) => onChange({ ...settings, musicVolume: Number(event.target.value) })} />
        </label>
        <label className="range-row setting-block">
          <span><Volume2 aria-hidden="true" /><span><strong>Hit feedback</strong><small>{Math.round(settings.feedbackVolume * 100)}%</small></span></span>
          <input type="range" min={0} max={1} step={0.05} value={settings.feedbackVolume} onChange={(event) => onChange({ ...settings, feedbackVolume: Number(event.target.value) })} />
        </label>
        <button className="calibration-entry setting-block" onClick={onCalibration}>
          <Activity aria-hidden="true" /><span><strong>Audio alignment</strong><small>Optional · current offset: {settings.calibrationMs > 0 ? '+' : ''}{settings.calibrationMs} ms</small></span><b>Adjust</b>
        </button>
      </div>
      <p className="privacy-note"><a href="/licenses/attribution.txt" target="_blank" rel="noreferrer">Music credits</a> · <a href="/licenses/third-party-notices.txt" target="_blank" rel="noreferrer">Open-source notices</a></p>
    </section>
  );
}
