import React from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles.css';
import { DiscussionList, DiscussionThread } from '../src/views/Discussions';
import { discussionDetail, discussionSummary, discussionTurn } from '../src/test/fixtures';

const question = `https://example.com/${'a'.repeat(280)}`;
const attachments = Array.from({ length: 4 }, (_, i) => ({ name: `image-${i + 1}.png`, mime: 'image/png', size: 68 }));
const summary = { ...discussionSummary, question, attachments };
const detail = { ...discussionDetail, question, attachments, turns: [discussionTurn({ text: question })] };
window.fetch = async (input) => new Response(JSON.stringify(String(input).endsWith('/api/discussions') ? [summary] : detail), {
  headers: { 'content-type': 'application/json' },
});

createRoot(document.getElementById('root')!).render(
  new URLSearchParams(location.search).has('thread')
    ? <DiscussionThread id="d-1" onBack={() => {}} />
    : <DiscussionList repos={[]} onOpen={() => {}} />,
);
