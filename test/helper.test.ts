import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lastExchange, type PageNode, readyReply } from '../src/helper.ts';

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

test('the last exchange is the newest prompt and every paragraph of its reply', () => {
  assert.deepEqual(lastExchange(page), {
    previous: 'first question',
    prompt: 'second\nquestion',
    reply: 'Paragraph one.\nParagraph two.',
    complete: true,
  });
});

test('a reply without its action buttons is still being written', () => {
  assert.equal(lastExchange(page.slice(0, 10))?.complete, false);
  assert.equal(lastExchange(page.slice(0, 8))?.reply, '');
});

test('a page without messages has no exchange', () => {
  assert.equal(lastExchange([text('ChatGPT 可能会出错。')]), null);
});

test('label text inside a message is content, not a new message', () => {
  const quoted = [
    label('你说：'),
    text('What does 你说：mean?'),
    label('ChatGPT 说：'),
    text('It means "you said".'),
    button('更多操作'),
  ];
  assert.deepEqual(lastExchange(quoted), {
    previous: null,
    prompt: 'What does 你说：mean?',
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
  assert.deepEqual(lastExchange(page), { previous: null, prompt: 'Q', reply: 'Start\n你说：\nQ\nend', complete: true });
});

test('a prompt matches the page however the page lays out its whitespace and inline code', () => {
  const state = {
    busy: false,
    exchange: { previous: 'Earlier', prompt: 'Use\nls -a, then stop.', reply: 'Done.', complete: true },
  };
  assert.equal(readyReply(state, 'Use `ls -a`, then stop.', 'Earlier'), 'Done.');
  assert.equal(readyReply(state, 'Use `ls -l`, then stop.', 'Earlier'), null);
  assert.equal(readyReply(state, 'Use `ls -a`, then stop.', null), null);
});
