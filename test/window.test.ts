import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lastExchange, type PageNode } from '../src/window.ts';

const text = (name: string): PageNode => ({ type: 'Text', name });
const button = (name: string): PageNode => ({ type: 'Button', name });

const page: PageNode[] = [
  text('你说：'),
  text('first question'),
  button('复制消息'),
  text('ChatGPT 说：'),
  text('first answer'),
  button('更多操作'),
  text('你说：'),
  text('second\nquestion'),
  text('ChatGPT 说：'),
  text('Paragraph one.'),
  button('复制'),
  text('Paragraph two.'),
  button('更多操作'),
  text('ChatGPT 可能会出错。'),
];

test('the last exchange is the newest prompt and every paragraph of its reply', () => {
  assert.deepEqual(lastExchange(page), {
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
