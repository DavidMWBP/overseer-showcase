import { useState } from 'react';
import { Mascot, type MascotEnergy, type MascotState } from '../components/Mascot';
import './MascotSheet.css';

const states: MascotState[] = ['idle', 'thinking', 'working', 'asking', 'sleeping', 'offline', 'error'];
const energies: MascotEnergy[] = ['high', 'normal', 'low'];

export function MascotSheet() {
  const [reduceMotion, setReduceMotion] = useState(false);
  return (
    <main className={`mascot-sheet${reduceMotion ? ' reduce-motion' : ''}`}>
      <header className="mascot-sheet-header">
        <div><p className="eyebrow">Overseer character study</p><h1>Mascot pose sheet</h1><p>Pixel-art states at rail and full-body sizes.</p></div>
        <label><input type="checkbox" checked={reduceMotion} onChange={(event) => setReduceMotion(event.target.checked)} /> Reduce motion</label>
      </header>
      <div className="mascot-sheet-grid">
        {states.flatMap((state) => energies.map((energy) => (
          <figure className="mascot-swatch" key={`${state}-${energy}`}>
            <div className="mascot-sizes">
              <Mascot state={state} energy={energy} size={32} label={`${state}, ${energy} energy, small`} />
              <Mascot state={state} energy={energy} size={64} label={`${state}, ${energy} energy, large`} />
            </div>
            <figcaption><strong>{state}</strong><span>{energy} energy · 32 / 64 px</span></figcaption>
          </figure>
        )))}
      </div>
    </main>
  );
}
