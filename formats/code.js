import Block from '../blots/block';
import Break from '../blots/break';
import Cursor from '../blots/cursor';
import Inline from '../blots/inline';
import TextBlot, { escapeText } from '../blots/text';
import Container from '../blots/container';
import Quill from '../core/quill';
import ListContainer from './list'

class CodeBlockContainer extends Container {
  static create(value) {
    const domNode = super.create(value);
    domNode.setAttribute('spellcheck', false);
    return domNode;
  }

  html(index, length) {
    const text = this.children
      .map(child => child.domNode.innerText)
      .join('\n')
      .slice(index, index + length);
    return `<pre>${escapeText(text)}</pre>`;
  }
}

class CodeBlock extends Block {
  static register() {
    Quill.register(CodeBlockContainer);
  }
}

class Code extends Inline {
  static create(value) {
    lplog('code--------------------------------')
    const domNode = super.create(value);
    return domNode;
  }
}
Code.blotName = 'code';
Code.tagName = 'CODE';

CodeBlock.blotName = 'code-block';
CodeBlock.className = 'ql-code-block';
CodeBlock.tagName = 'DIV';
CodeBlockContainer.blotName = 'code-block-container';
CodeBlockContainer.className = 'ql-code-block-container';
CodeBlockContainer.tagName = 'DIV';

CodeBlockContainer.allowedChildren = [CodeBlock];

CodeBlock.allowedChildren = [TextBlot, Break, Cursor, ListContainer];
CodeBlock.requiredContainer = CodeBlockContainer;
CodeBlock.TAB = '  ';

export { Code, CodeBlockContainer, CodeBlock as default };
