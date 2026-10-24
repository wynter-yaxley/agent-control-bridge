import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type PageNode, readPage, replyTo, samePrompt } from '../src/helper.ts';

const text = (name: string): PageNode => ({ type: 'Text', name });
const label = (name: string): PageNode => ({ type: 'Text', name, label: true });
const button = (name: string): PageNode => ({ type: 'Button', name });

const page: PageNode[] = [
  label('你说：'),
  text('first question'),
  button('复制消息'),
  label('ChatGPT 说：'),
  text('first answer'),
  button('更多操作'),
  label('你说：'),
  text('second\nquestion'),
  label('ChatGPT 说：'),
  text('Paragraph one.'),
  button('复制'),
  text('Paragraph two.'),
  button('更多操作'),
  text('ChatGPT 可能会出错。'),
];

test('a page holds every prompt and every paragraph of the last reply', () => {
  assert.deepEqual(readPage(page, false), {
    busy: false,
    prompts: ['first question', 'second\nquestion'],
    reply: 'Paragraph one.\nParagraph two.',
    complete: true,
  });
});

test('a reply without its action buttons is still being written', () => {
  assert.equal(readPage(page.slice(0, 10), false).complete, false);
  assert.equal(readPage(page.slice(0, 8), false).reply, '');
});

test('a page without messages has no prompts', () => {
  assert.deepEqual(readPage([text('ChatGPT 可能会出错。')], false).prompts, []);
});

test('label text inside a message is content, not a new message', () => {
  const quoted = [
    label('你说：'),
    text('What does 你说：mean?'),
    label('ChatGPT 说：'),
    text('It means "you said".'),
    button('更多操作'),
  ];
  assert.deepEqual(readPage(quoted, false), {
    busy: false,
    prompts: ['What does 你说：mean?'],
    reply: 'It means "you said".',
    complete: true,
  });
});

test('message text that equals a role heading is still message text', () => {
  const page = [
    label('你说：'),
    text('Q'),
    label('ChatGPT 说：'),
    text('Start'),
    text('你说：'),
    text('Q'),
    text('end'),
    button('更多操作'),
  ];
  assert.deepEqual(readPage(page, false), {
    busy: false,
    prompts: ['Q'],
    reply: 'Start\n你说：\nQ\nend',
    complete: true,
  });
});

test('a prompt matches the page despite its inline code and line breaks, not despite other changes', () => {
  assert.ok(samePrompt('Use ls -a, then\nstop.', 'Use `ls -a`, then stop.'));
  assert.ok(!samePrompt('Use ls -a, then stop.', 'Use `ls -l`, then stop.'));
  assert.ok(!samePrompt('ab', 'a b'));
});

test('a reply is taken only from a finished page ending with the expected prompts', () => {
  const state = { busy: false, prompts: ['Earlier', 'Question'], reply: 'Done.', complete: true };
  assert.equal(replyTo(state, ['Earlier', 'Question']), 'Done.');
  assert.equal(replyTo(state, ['Question']), 'Done.');
  assert.equal(replyTo(state, ['Question'], true), null, 'the page shows more than expected');
  assert.equal(replyTo(state, ['Other', 'Question']), null);
  assert.equal(replyTo({ ...state, busy: true }, ['Question']), null);
  assert.equal(replyTo({ ...state, complete: false }, ['Question']), null);
});
