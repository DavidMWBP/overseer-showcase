import React from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles.css';
import { PlainText } from '../src/components/PlainText';

const note = '| Check | Command | Result |\n| --- | --- | --- |\n| wide table | `node --test packages/web/src/components/PlainText.test.tsx` | pass |';
createRoot(document.getElementById('root')!).render(
  <div className="review-layout"><div className="review-list" /><div className="review-detail">
    <div className="pre review-note"><PlainText text={note} tables /></div>
  </div></div>,
);
