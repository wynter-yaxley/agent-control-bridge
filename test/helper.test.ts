import assert from 'node:assert/strict';
import { test } from 'node:test';
import { atEnd, type PageNode, readPage, replyTo, samePrompt, shownAfter, showsPrompts } from '../src/helper.ts';

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
  assert.deepEqual(readPage(page), {
    prompts: ['first question', 'second\nquestion'],
    reply: 'Paragraph one.\nParagraph two.',
    complete: true,
  });
});

test('a reply without its action buttons is still being written', () => {
  assert.equal(readPage(page.slice(0, 10)).complete, false);
  assert.equal(readPage(page.slice(0, 8)).reply, '');
});

test('a page without messages has no prompts', () => {
  assert.deepEqual(readPage([text('ChatGPT 可能会出错。')]).prompts, []);
});

test('label text inside a message is content, not a new message', () => {
  const quoted = [
    label('你说：'),
    text('What does 你说：mean?'),
    label('ChatGPT 说：'),
    text('It means "you said".'),
    button('更多操作'),
  ];
  assert.deepEqual(readPage(quoted), {
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
  assert.deepEqual(readPage(page), {
    prompts: ['Q'],
    reply: 'Start\n你说：\nQ\nend',
    complete: true,
  });
});

test('a prompt matches the page despite the backticks of its inline code, not despite other changes', () => {
  assert.ok(samePrompt('Use ls -a, then\nstop.\r\n', 'Use `ls -a`, then\nstop.'));
  assert.ok(!samePrompt('Use ls -a, then stop.', 'Use `ls -l`, then stop.'));
  assert.ok(!samePrompt('ab', 'a b'));
  assert.ok(!samePrompt('print("a b")', 'print("a  b")'));
  assert.ok(!samePrompt('a b', 'a\nb'));
});

test('the messages after the known ones are found only where the page shows them once', () => {
  const page = { prompts: ['X', 'Q', 'R'], reply: '', complete: false };
  assert.deepEqual(shownAfter(page, ['X']), ['Q', 'R']);
  assert.deepEqual(shownAfter(page, ['Q', 'R']), []);
  assert.equal(shownAfter(page, ['Y']), undefined);
  assert.equal(shownAfter(page, []), undefined);
  assert.equal(shownAfter({ ...page, prompts: ['Q', 'R', 'Q', 'R'] }, ['Q', 'R']), undefined, 'twice');
});

test('a page holding only the newest messages is compared on those, but on two at least', () => {
  const page = { prompts: ['C', 'D', 'E'], reply: '', complete: false };
  assert.ok(showsPrompts(page, ['A', 'B', 'C', 'D', 'E']));
  assert.ok(!showsPrompts(page, ['A', 'B', 'X', 'D', 'E']));
  assert.ok(!showsPrompts({ ...page, prompts: ['E'] }, ['D', 'E']));
  assert.ok(showsPrompts({ ...page, prompts: ['E'] }, ['E']));
});

test('a reply is taken only from a finished page ending with the expected prompts', () => {
  const state = {
    busy: false,
    atEnd: true,
    scroll: null,
    older: false,
    messages: [],
    prompts: ['Earlier', 'Question'],
    reply: 'Done.',
    complete: true,
  };
  assert.equal(replyTo(state, ['Earlier', 'Question']), 'Done.');
  assert.equal(replyTo(state, ['Question']), 'Done.');
  assert.equal(replyTo(state, ['Other', 'Question']), null);
  assert.equal(replyTo({ ...state, busy: true }, ['Question']), null);
  assert.equal(replyTo({ ...state, complete: false }, ['Question']), null);
  assert.equal(replyTo({ ...state, atEnd: false }, ['Question']), null, 'scrolled up to older messages');
});

test('a page counts as at its end only within a small part of a screen from it', () => {
  assert.ok(atEnd(null), 'a conversation that fits');
  assert.ok(atEnd({ percent: 100, view: 4 }));
  assert.ok(atEnd({ percent: 99.99, view: 4 }));
  // 200,000 pixels of history, 800 showing, 1,500 above the end: 99.25 percent down.
  assert.ok(!atEnd({ percent: 99.25, view: 0.4 }));
  assert.ok(!atEnd({ percent: 50, view: 50 }));
});
