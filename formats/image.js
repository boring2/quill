import { EmbedBlot } from 'parchment';
import { sanitize } from './link';

const ATTRIBUTES = ['alt', 'width', 'height', 'data-id', 'scale'];

class Image extends EmbedBlot {
  static create(value) {
    const node = super.create(value);
    node.classList.add('loading')
    if (typeof value === 'string') {
      // let defaultWidth = 300
      // node.setAttribute('width', defaultWidth)
      if (value.startsWith('./icons') || value.startsWith('http://') || value.startsWith('https://')) {
        node.setAttribute('src', value)
        setTimeout(() => {
          node.classList.remove('loading')
        }, 1000)
        window.LPNote.FileLoader.saveRemoteAsset(value).then(({id, base64}) => {
          window.isModified = true
          node.setAttribute('src', base64)
          node.setAttribute('scale', true)
          node.setAttribute('data-id', id)
          node.classList.remove('loading')
        })
        // 针对base64图片做存储
      } else if (value.startsWith('data:image')) {
        window.LPNote.FileLoader.saveAsset(value).then((id) => {
          node.setAttribute('src', value)
          node.setAttribute('scale', true)
          node.setAttribute('data-id', id)
          node.classList.remove('loading')
        })
      } else {
        // 暂且认为都是我们的id
        let id = value
        console.log("data-id-------------", id)
        // node.setAttribute('src', './icons/angry@3x.png')
        window.LPNote.FileLoader.load(id).then((data) => {
          node.setAttribute('src', this.sanitize(data));
          node.classList.remove('loading')
        })
      }
    } else if (typeof value === 'object') {
      value.src && node.setAttribute('src', this.sanitize(value.src));
      value.alt && node.setAttribute('alt', value.alt);
      value.width && node.setAttribute('width', value.width);
      value.height && node.setAttribute('height', value.height);
      value.dataId && node.setAttribute('data-id', value.dataId);
      value.scale && node.setAttribute('scale', true);
      node.classList.remove('loading')
    }
    return node;
  }

  static formats(domNode) {
    return ATTRIBUTES.reduce((formats, attribute) => {
      if (domNode.hasAttribute(attribute)) {
        formats[attribute] = domNode.getAttribute(attribute);
      }
      return formats;
    }, {});
  }

  static match(url) {
    return /\.(jpe?g|gif|png)$/.test(url) || /^data:image\/.+;base64/.test(url);
  }

  static register() {
    if (/Firefox/i.test(navigator.userAgent)) {
      setTimeout(() => {
        // Disable image resizing in Firefox
        document.execCommand('enableObjectResizing', false, false);
      }, 1);
    }
  }

  static sanitize(url) {
    return sanitize(url, ['http', 'https', 'data', 'file']) ? url : '//:0';
  }

  static value(domNode) {
    return domNode.getAttribute('data-id') || domNode.getAttribute('src');
  }

  format(name, value) {
    if (ATTRIBUTES.indexOf(name) > -1) {
      if (value) {
        if (name === 'width') {
          let oldValue = value
          value = Math.min(window.innerWidth * 0.8, oldValue)
          this.isFixScale = (value / oldValue)
        } else if (name === 'height') {
          if (this.isFixScale) {
            value = value * this.isFixScale
          }
        }
        this.domNode.setAttribute(name, value);
      } else {
        this.domNode.removeAttribute(name);
      }
    } else {
      super.format(name, value);
    }
  }
}
Image.blotName = 'image';
Image.tagName = 'IMG';

export default Image;
