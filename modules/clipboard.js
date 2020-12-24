import Delta from 'quill-delta';
import { MarkdownToQuill } from 'md-to-quill-delta';
import EventBus from 'utils/eventbus';
import {
  Attributor,
  ClassAttributor,
  EmbedBlot,
  Scope,
  // StyleAttributor,
  BlockBlot,
} from 'parchment';
import TurndownService from '../../../utils/turndown';
import { BlockEmbed } from '../blots/block';
import Quill from '../core/quill';
import logger from '../core/logger';
import Module from '../core/module';

import { AlignAttribute, AlignStyle } from '../formats/align';
import { BackgroundStyle } from '../formats/background';
import CodeBlock from '../formats/code';
import { ColorStyle } from '../formats/color';
import { DirectionAttribute, DirectionStyle } from '../formats/direction';
import { FontStyle } from '../formats/font';
import { SizeStyle } from '../formats/size';

const converter = new MarkdownToQuill({ debug: false });

const turndownService = new TurndownService({
  headingStyle: 'atx',
});

turndownService.addRule('ph', {
  filter: 'p',
  replacement(content) {
    return `${content}\n`;
  },
});
turndownService.addRule('check', {
  filter: 'li',
  replacement(content, node, options) {
    if (node.getAttribute('data-list') === 'unchecked') {
      return `[ ] ${content}`;
    }
    if (node.getAttribute('data-list') === 'checked') {
      return `[x] ${content}`;
    }
    content = content
      .replace(/^\n+/, '') // remove leading newlines
      .replace(/\n+$/, '\n') // replace trailing newlines with just a single one
      .replace(/\n/gm, '\n    '); // indent
    let prefix = `${options.bulletListMarker}   `;
    const parent = node.parentNode;
    if (parent.nodeName === 'OL') {
      const start = parent.getAttribute('start');
      const index = Array.prototype.indexOf.call(parent.children, node);
      prefix = `${start ? Number(start) + index : index + 1}.  `;
    }
    return (
      prefix + content + (node.nextSibling && !/\n$/.test(content) ? '\n' : '')
    );
  },
});

// turndownService.addRule('td', {
//   filter: ['td'],
//   replacement(content) {
//     return `|  ${content}  `;
//   },
// });

// turndownService.addRule('strikethrough', {
//   filter: ['del', 's', 'strike'],
//   replacement(content) {
//     return `~~${content}~~`;
//   },
// });

// turndownService.addRule('code', {
//   filter: ['pre'],
//   replacement(content) {
//     return `\`\`\`javascript\n${content}\n\`\`\``;
//   },
// });

const debug = logger('quill:clipboard');

const CLIPBOARD_CONFIG = [
  [Node.TEXT_NODE, matchText],
  [Node.TEXT_NODE, matchNewline],
  ['br', matchBreak],
  [Node.ELEMENT_NODE, matchNewline],
  [Node.ELEMENT_NODE, matchBlot],
  [Node.ELEMENT_NODE, matchAttributor],
  [Node.ELEMENT_NODE, matchStyles],
  ['li', matchIndent],
  ['ol, ul', matchList],
  ['pre', matchCodeBlock],
  ['tr', matchTable],
  ['b', matchAlias.bind(matchAlias, 'bold')],
  ['i', matchAlias.bind(matchAlias, 'italic')],
  ['strike', matchAlias.bind(matchAlias, 'strike')],
  ['style', matchIgnore],
];

const ATTRIBUTE_ATTRIBUTORS = [AlignAttribute, DirectionAttribute].reduce(
  (memo, attr) => {
    memo[attr.keyName] = attr;
    return memo;
  },
  {},
);

const STYLE_ATTRIBUTORS = [
  AlignStyle,
  BackgroundStyle,
  ColorStyle,
  DirectionStyle,
  FontStyle,
  SizeStyle,
].reduce((memo, attr) => {
  memo[attr.keyName] = attr;
  return memo;
}, {});

class Clipboard extends Module {
  constructor(quill, options) {
    super(quill, options);
    this.quill.root.addEventListener('copy', e => this.onCaptureCopy(e, false));
    this.quill.root.addEventListener('cut', e => this.onCaptureCopy(e, true));
    this.quill.root.addEventListener('paste', this.onCapturePaste.bind(this));
    this.matchers = [];
    CLIPBOARD_CONFIG.concat(this.options.matchers).forEach(
      ([selector, matcher]) => {
        this.addMatcher(selector, matcher);
      },
    );
    // console.log(this.matchers, '-------------------------');
  }

  addMatcher(selector, matcher) {
    this.matchers.push([selector, matcher]);
  }

  convert({ html, text }, formats = {}) {
    // 处理下table-cell-line
    if (formats['table-cell-line']) {
      const ops = text.split('\n').reduce((op, t) => {
        if (t) {
          op.push({
            insert: t,
          });
        }
        op.push({
          insert: '\n',
          attributes: {
            ...formats,
          },
        });
        return op;
      }, []);
      ops[ops.length - 1].insert = '';
      return new Delta({ ops });
    }

    if (formats[CodeBlock.blotName]) {
      return new Delta().insert(text, {
        [CodeBlock.blotName]: formats[CodeBlock.blotName],
      });
    }
    if (!html) {
      return { ops: converter.convert(text || '') };
      // return new Delta().insert(text || '');
    }
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const container = doc.body;
    container.childNodes.forEach(node => {
      if (node.removeAttribute) {
        node.removeAttribute('id');
        // node.removeAttribute('class');
      }
    });
    const nodeMatches = new WeakMap();
    const [elementMatchers, textMatchers] = this.prepareMatching(
      container,
      nodeMatches,
    );
    const delta = traverse(
      this.quill.scroll,
      container,
      elementMatchers,
      textMatchers,
      nodeMatches,
    );
    // console.log('traverse to ----------', delta);
    // Remove trailing newline
    if (
      deltaEndsWith(delta, '\n') &&
      (delta.ops[delta.ops.length - 1].attributes == null || formats.table)
    ) {
      return delta.compose(new Delta().retain(delta.length() - 1).delete(1));
    }
    return delta;
  }

  dangerouslyPasteHTML(index, html, source = Quill.sources.API) {
    if (typeof index === 'string') {
      const delta = this.convert({ html: index, text: '' });
      this.quill.setContents(delta, html);
      this.quill.setSelection(0, Quill.sources.SILENT);
    } else {
      const paste = this.convert({ html, text: '' });
      this.quill.updateContents(
        new Delta().retain(index).concat(paste),
        source,
      );
      this.quill.setSelection(index + paste.length(), Quill.sources.SILENT);
    }
  }

  onCaptureCopy(e, isCut = false) {
    // 代码的复制
    if (
      e.target.classList &&
      (e.target.classList.contains('code-copy') ||
        e.target.classList.contains('ql-code-block'))
    ) {
      e.preventDefault();
      const parentNote = e.target.parentNode;
      let str = '';
      parentNote.querySelectorAll('.ql-code-block').forEach(d => {
        str += `${d.innerText}\n`;
      });
      e.clipboardData.setData('text/plain', str);
      return;
    }

    // 表格内的复制
    const format = this.quill.getFormat();
    const [range] = this.quill.selection.getRange();
    if (range == null) return;

    if (format['table-cell-line']) {
      e.preventDefault();
      const str = this.quill.getText(range.index, range.length);
      e.clipboardData.setData('text/plain', str);
      if (isCut) {
        this.quill.deleteText(
          { index: range.index, length: str.trim().length },
          Quill.sources.USER,
        );
      }
      return;
    }

    if (e.defaultPrevented) return;
    e.preventDefault();

    const { html, text } = this.onCopy(range, isCut);
    e.clipboardData.setData('text/plain', text);
    e.clipboardData.setData('text/html', html);
    if (isCut) {
      this.quill.deleteText(range, Quill.sources.USER);
    }
  }

  onCapturePaste(e) {
    if (e.defaultPrevented || !this.quill.isEnabled()) return;
    e.preventDefault();
    const range = this.quill.getSelection(true);
    if (range == null) return;
    let html = e.clipboardData.getData('text/html');
    if (html) {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      doc.body.querySelectorAll('noscript').forEach(dom => {
        dom.remove();
      });
      html = doc.body.outerHTML;
    }

    const text = e.clipboardData.getData('text/plain');
    // console.log('text------------------', text);
    const files = Array.from(e.clipboardData.files || []);
    if (!html && files.length > 0) {
      this.quill.uploader.upload(range, files);
    } else {
      this.onPaste(range, { html, text });
    }
  }

  onCopy(range) {
    const html = this.quill.getSemanticHTML(range);
    // 把 html转成 md
    const markdown = turndownService.turndown(html);
    lplog(html);
    lplog(markdown);
    return { html, text: markdown };
  }

  onPaste(range, { text, html }) {
    const formats = this.quill.getFormat(range.index);
    // 去掉html
    const pastedDelta = this.convert({ text, html }, formats);
    // const pastedDelta = this.convert({ text }, formats);
    const isTable = formats.row;
    const delta = new Delta()
      .retain(range.index)
      .delete(isTable && range.length === 1 ? 0 : range.length)
      .concat(pastedDelta);
    this.quill.updateContents(delta, Quill.sources.USER);
    // range.length contributes to delta.length()
    this.quill.setSelection(
      delta.length() - range.length,
      Quill.sources.SILENT,
    );
    this.quill.scrollIntoView();
    setTimeout(() => {
      EventBus.$emit('needRainbow');
    }, 0);
  }

  prepareMatching(container, nodeMatches) {
    const elementMatchers = [];
    const textMatchers = [];
    this.matchers.forEach(pair => {
      const [selector, matcher] = pair;
      switch (selector) {
        case Node.TEXT_NODE:
          textMatchers.push(matcher);
          break;
        case Node.ELEMENT_NODE:
          elementMatchers.push(matcher);
          break;
        default:
          Array.from(container.querySelectorAll(selector)).forEach(node => {
            if (nodeMatches.has(node)) {
              const matches = nodeMatches.get(node);
              matches.push(matcher);
            } else {
              nodeMatches.set(node, [matcher]);
            }
          });
          break;
      }
    });
    return [elementMatchers, textMatchers];
  }
}
Clipboard.DEFAULTS = {
  matchers: [],
};

function applyFormat(delta, format, value) {
  // console.log('applyFormat', delta, format);
  if (typeof format === 'object') {
    return Object.keys(format).reduce((newDelta, key) => {
      return applyFormat(newDelta, key, format[key]);
    }, delta);
  }
  return delta.reduce((newDelta, op) => {
    if (op.attributes && op.attributes[format]) {
      return newDelta.push(op);
    }
    const formats = value ? { [format]: value } : {};
    return newDelta.insert(op.insert, { ...formats, ...op.attributes });
  }, new Delta());
}

function deltaEndsWith(delta, text) {
  let endText = '';
  for (
    let i = delta.ops.length - 1;
    i >= 0 && endText.length < text.length;
    --i // eslint-disable-line no-plusplus
  ) {
    const op = delta.ops[i];
    if (typeof op.insert !== 'string') break;
    endText = op.insert + endText;
  }
  return endText.slice(-1 * text.length) === text;
}

function isLine(node) {
  if (node.childNodes.length === 0) return false; // Exclude embed blocks
  return [
    'address',
    'article',
    'blockquote',
    'canvas',
    'dd',
    'div',
    'dl',
    'dt',
    'fieldset',
    'figcaption',
    'figure',
    'footer',
    'form',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'header',
    'iframe',
    'li',
    'main',
    'nav',
    'ol',
    'output',
    'p',
    'pre',
    'section',
    'table',
    'td',
    'tr',
    'ul',
    'video',
  ].includes(node.tagName.toLowerCase());
}

const preNodes = new WeakMap();
function isPre(node) {
  if (node == null) return false;
  if (!preNodes.has(node)) {
    if (node.tagName === 'PRE') {
      preNodes.set(node, true);
    } else {
      preNodes.set(node, isPre(node.parentNode));
    }
  }
  return preNodes.get(node);
}

function traverse(scroll, node, elementMatchers, textMatchers, nodeMatches) {
  // console.log(node, textMatchers, elementMatchers, nodeMatches);
  // Post-order
  if (node.nodeType === node.TEXT_NODE) {
    return textMatchers.reduce((delta, matcher) => {
      return matcher(node, delta, scroll);
    }, new Delta());
  }
  if (node.nodeType === node.ELEMENT_NODE) {
    return Array.from(node.childNodes || []).reduce((delta, childNode) => {
      let childrenDelta = traverse(
        scroll,
        childNode,
        elementMatchers,
        textMatchers,
        nodeMatches,
      );
      if (childNode.nodeType === node.ELEMENT_NODE) {
        childrenDelta = elementMatchers.reduce((reducedDelta, matcher) => {
          return matcher(childNode, reducedDelta, scroll);
        }, childrenDelta);
        childrenDelta = (nodeMatches.get(childNode) || []).reduce(
          (reducedDelta, matcher) => {
            return matcher(childNode, reducedDelta, scroll);
          },
          childrenDelta,
        );
      }
      return delta.concat(childrenDelta);
    }, new Delta());
  }
  return new Delta();
}

function matchAlias(format, node, delta) {
  return applyFormat(delta, format, true);
}

function matchAttributor(node, delta, scroll) {
  const attributes = Attributor.keys(node);
  const classes = ClassAttributor.keys(node);
  const styles = []; // StyleAttributor.keys(node);
  const formats = {};
  attributes
    .concat(classes)
    .concat(styles)
    .forEach(name => {
      let attr = scroll.query(name, Scope.ATTRIBUTE);
      if (attr != null) {
        formats[attr.attrName] = attr.value(node);
        if (formats[attr.attrName]) return;
      }
      attr = ATTRIBUTE_ATTRIBUTORS[name];
      if (attr != null && (attr.attrName === name || attr.keyName === name)) {
        formats[attr.attrName] = attr.value(node) || undefined;
      }
      attr = STYLE_ATTRIBUTORS[name];
      if (attr != null && (attr.attrName === name || attr.keyName === name)) {
        attr = STYLE_ATTRIBUTORS[name];
        formats[attr.attrName] = attr.value(node) || undefined;
      }
    });
  if (Object.keys(formats).length > 0) {
    return applyFormat(delta, formats);
  }
  return delta;
}

function matchBlot(node, delta, scroll) {
  const match = scroll.query(node);
  if (match == null) return delta;
  if (match.prototype instanceof EmbedBlot) {
    const embed = {};
    const value = match.value(node);
    if (value != null) {
      embed[match.blotName] = value;
      return new Delta().insert(embed, match.formats(node, scroll));
    }
  } else {
    if (match.prototype instanceof BlockBlot && !deltaEndsWith(delta, '\n')) {
      delta.insert('\n');
    }
    if (typeof match.formats === 'function') {
      return applyFormat(delta, match.blotName, match.formats(node, scroll));
    }
  }
  return delta;
}

function matchBreak(node, delta) {
  if (!deltaEndsWith(delta, '\n')) {
    delta.insert('\n');
  }
  return delta;
}

function matchCodeBlock(node, delta, scroll) {
  const match = scroll.query('code-block');
  const language = match ? match.formats(node, scroll) : true;
  return applyFormat(
    delta,
    'code-block',
    language === 'plain' ? 'javascript' : language,
  );
}

function matchIgnore() {
  return new Delta();
}

function matchIndent(node, delta, scroll) {
  const match = scroll.query(node);
  if (
    match == null ||
    match.blotName !== 'list' ||
    !deltaEndsWith(delta, '\n')
  ) {
    return delta;
  }
  let indent = -1;
  let parent = node.parentNode;
  while (parent != null) {
    if (['OL', 'UL'].includes(parent.tagName)) {
      indent += 1;
    }
    parent = parent.parentNode;
  }
  if (indent <= 0) return delta;
  return delta.reduce((composed, op) => {
    // if (op.attributes && op.attributes.list) {
    // return composed.push(op);
    // }
    return composed.insert(op.insert, { indent, ...(op.attributes || {}) });
  }, new Delta());
}

function matchList(node, delta) {
  const list = node.tagName === 'OL' ? 'ordered' : 'bullet';
  return applyFormat(delta, 'list', { value: list, fold: 'unfold' });
}

function matchNewline(node, delta, scroll) {
  if (!deltaEndsWith(delta, '\n')) {
    if (isLine(node)) {
      return delta.insert('\n');
    }
    if (delta.length() > 0 && node.nextSibling) {
      let { nextSibling } = node;
      while (nextSibling != null) {
        if (isLine(nextSibling)) {
          return delta.insert('\n');
        }
        const match = scroll.query(nextSibling);
        if (match && match.prototype instanceof BlockEmbed) {
          return delta.insert('\n');
        }
        nextSibling = nextSibling.firstChild;
      }
    }
  }
  return delta;
}

function matchStyles(node, delta) {
  const formats = {};
  const style = node.style || {};
  if (style.fontStyle === 'italic') {
    formats.italic = true;
  }
  if (style.textDecoration === 'underline') {
    formats.underline = true;
  }
  if (style.textDecoration === 'line-through') {
    formats.strike = true;
  }
  if (
    (style.fontWeight && style.fontWeight.startsWith('bold')) ||
    parseInt(style.fontWeight, 10) >= 700
  ) {
    formats.bold = true;
  }
  if (Object.keys(formats).length > 0) {
    delta = applyFormat(delta, formats);
  }
  if (parseFloat(style.textIndent || 0) > 0) {
    // Could be 0.5in
    return new Delta().insert('\t').concat(delta);
  }
  return delta;
}

function matchTable(node, delta) {
  const table =
    node.parentNode.tagName === 'TABLE'
      ? node.parentNode
      : node.parentNode.parentNode;
  const rows = Array.from(table.querySelectorAll('tr'));
  const row = rows.indexOf(node) + 1;
  return applyFormat(delta, 'table', row);
}

function matchText(node, delta) {
  let text = node.data;
  // Word represents empty line with <o:p>&nbsp;</o:p>
  if (node.parentNode.tagName === 'O:P') {
    return delta.insert(text.trim());
  }
  if (text.trim().length === 0 && text.includes('\n')) {
    return delta;
  }
  if (!isPre(node)) {
    const replacer = (collapse, match) => {
      const replaced = match.replace(/[^\u00a0]/g, ''); // \u00a0 is nbsp;
      return replaced.length < 1 && collapse ? ' ' : replaced;
    };
    text = text.replace(/\r\n/g, ' ').replace(/\n/g, ' ');
    text = text.replace(/\s\s+/g, replacer.bind(replacer, true)); // collapse whitespace
    if (
      (node.previousSibling == null && isLine(node.parentNode)) ||
      (node.previousSibling != null && isLine(node.previousSibling))
    ) {
      text = text.replace(/^\s+/, replacer.bind(replacer, false));
    }
    if (
      (node.nextSibling == null && isLine(node.parentNode)) ||
      (node.nextSibling != null && isLine(node.nextSibling))
    ) {
      text = text.replace(/\s+$/, replacer.bind(replacer, false));
    }
  }
  return delta.insert(text);
}

export {
  Clipboard as default,
  matchAttributor,
  matchBlot,
  matchNewline,
  matchText,
  traverse,
};
