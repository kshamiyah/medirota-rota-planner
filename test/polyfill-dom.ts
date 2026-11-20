/**
 * Minimal DOM so React createRoot + useEffect can run in Node vitest.
 * Enough for SetupWizard bookmark/finish link checks; not a full browser.
 */
type AnyNode = {
  nodeType: number;
  nodeName: string;
  tagName: string;
  childNodes: AnyNode[];
  children: AnyNode[];
  style: Record<string, string>;
  attributes: Record<string, string>;
  ownerDocument: Doc | null;
  parentNode: AnyNode | null;
  _text: string;
  textContent: string;
  nodeValue?: string;
  className: string;
  href: string;
  namespaceURI: string | null;
  setAttribute: (k: string, v: string) => void;
  getAttribute: (k: string) => string | null;
  removeAttribute: (k: string) => void;
  hasAttribute: (k: string) => boolean;
  setAttributeNS: (_ns: string | null, k: string, v: string) => void;
  appendChild: (c: AnyNode) => AnyNode;
  removeChild: (c: AnyNode) => AnyNode;
  insertBefore: (c: AnyNode, ref: AnyNode | null) => AnyNode;
  addEventListener: () => void;
  removeEventListener: () => void;
  dispatchEvent: () => boolean;
  cloneNode: (deep?: boolean) => AnyNode;
  focus: () => void;
  blur: () => void;
  firstChild: AnyNode | null;
  lastChild: AnyNode | null;
  nextSibling: AnyNode | null;
  previousSibling: AnyNode | null;
};

type Doc = {
  nodeType: number;
  documentElement: AnyNode;
  body: AnyNode;
  head: AnyNode;
  activeElement: AnyNode | null;
  title: string;
  defaultView: WindowLike | null;
  createElement: (tag: string) => AnyNode;
  createElementNS: (_ns: string | null, tag: string) => AnyNode;
  createTextNode: (text: string) => AnyNode;
  createComment: (text: string) => AnyNode;
  createDocumentFragment: () => AnyNode;
  getElementById: () => null;
  querySelector: () => null;
  querySelectorAll: () => AnyNode[];
  addEventListener: () => void;
  removeEventListener: () => void;
};

type WindowLike = Record<string, unknown> & {
  document: Doc;
  self: WindowLike;
  top: WindowLike;
  parent: WindowLike;
};

function makeNode(type: number, name = ''): AnyNode {
  const node: AnyNode = {
    nodeType: type,
    nodeName: name,
    tagName: name,
    childNodes: [],
    children: [],
    style: {},
    attributes: Object.create(null) as Record<string, string>,
    ownerDocument: null,
    parentNode: null,
    _text: '',
    get textContent() {
      if (this.nodeType === 3 || this.nodeType === 8) return this._text;
      return this.childNodes.map(child => child.textContent).join('');
    },
    set textContent(value: string) {
      this._text = String(value);
      if (this.nodeType === 1) {
        this.childNodes = [];
        this.children = [];
        if (value) {
          const text = makeNode(3, '#text');
          text._text = String(value);
          text.nodeValue = String(value);
          text.ownerDocument = this.ownerDocument;
          text.parentNode = this;
          this.childNodes.push(text);
        }
      }
    },
    className: '',
    href: '',
    namespaceURI: null,
    setAttribute(k, v) {
      this.attributes[k] = String(v);
      if (k === 'href') this.href = String(v);
      if (k === 'class') this.className = String(v);
    },
    getAttribute(k) { return k in this.attributes ? this.attributes[k]! : null; },
    removeAttribute(k) { delete this.attributes[k]; },
    hasAttribute(k) { return k in this.attributes; },
    setAttributeNS(_ns, k, v) { this.setAttribute(k, v); },
    appendChild(c) {
      if (c.parentNode) c.parentNode.removeChild(c);
      c.parentNode = this;
      this.childNodes.push(c);
      if (c.nodeType === 1) this.children.push(c);
      return c;
    },
    removeChild(c) {
      const i = this.childNodes.indexOf(c);
      if (i >= 0) this.childNodes.splice(i, 1);
      const j = this.children.indexOf(c);
      if (j >= 0) this.children.splice(j, 1);
      c.parentNode = null;
      return c;
    },
    insertBefore(c, ref) {
      if (c.parentNode) c.parentNode.removeChild(c);
      c.parentNode = this;
      const i = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
      this.childNodes.splice(i, 0, c);
      if (c.nodeType === 1) {
        const j = ref && ref.nodeType === 1 ? this.children.indexOf(ref) : this.children.length;
        this.children.splice(Math.max(0, j), 0, c);
      }
      return c;
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    cloneNode(deep) {
      const next = makeNode(this.nodeType, this.nodeName);
      next.ownerDocument = this.ownerDocument;
      if (deep) for (const child of this.childNodes) next.appendChild(child.cloneNode(true));
      return next;
    },
    focus() {},
    blur() {},
    get firstChild() { return this.childNodes[0] ?? null; },
    get lastChild() { return this.childNodes.at(-1) ?? null; },
    get nextSibling() {
      if (!this.parentNode) return null;
      const i = this.parentNode.childNodes.indexOf(this);
      return this.parentNode.childNodes[i + 1] ?? null;
    },
    get previousSibling() {
      if (!this.parentNode) return null;
      const i = this.parentNode.childNodes.indexOf(this);
      return this.parentNode.childNodes[i - 1] ?? null;
    },
  };
  return node;
}

function NodeCtor() {}
NodeCtor.ELEMENT_NODE = 1;
NodeCtor.TEXT_NODE = 3;
NodeCtor.COMMENT_NODE = 8;
NodeCtor.DOCUMENT_NODE = 9;
NodeCtor.DOCUMENT_FRAGMENT_NODE = 11;
function HTMLElement() {}
function Element() {}
function SVGElement() {}
function HTMLIFrameElement() {}
function HTMLInputElement() {}
function HTMLTextAreaElement() {}
function HTMLSelectElement() {}
function HTMLAnchorElement() {}

const document = {
  nodeType: 9,
  documentElement: null as unknown as AnyNode,
  body: null as unknown as AnyNode,
  head: null as unknown as AnyNode,
  activeElement: null as AnyNode | null,
  title: 'Rota Planner',
  defaultView: null as WindowLike | null,
  createElement(tag: string) {
    const n = makeNode(1, String(tag).toUpperCase());
    n.ownerDocument = document as Doc;
    return n;
  },
  createElementNS(_ns: string | null, tag: string) { return this.createElement(tag); },
  createTextNode(text: string) {
    const n = makeNode(3, '#text');
    n._text = String(text);
    n.nodeValue = String(text);
    n.ownerDocument = document as Doc;
    return n;
  },
  createComment(text: string) {
    const n = makeNode(8, '#comment');
    n._text = String(text);
    n.ownerDocument = document as Doc;
    return n;
  },
  createDocumentFragment() {
    const n = makeNode(11, '#document-fragment');
    n.ownerDocument = document as Doc;
    return n;
  },
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return [] as AnyNode[]; },
  addEventListener() {},
  removeEventListener() {},
} as Doc;

document.documentElement = document.createElement('html');
document.head = document.createElement('head');
document.body = document.createElement('body');
document.documentElement.appendChild(document.head);
document.documentElement.appendChild(document.body);

const windowObj = {
  document,
  HTMLElement,
  Element,
  SVGElement,
  HTMLIFrameElement,
  HTMLInputElement,
  HTMLTextAreaElement,
  HTMLSelectElement,
  HTMLAnchorElement,
  Node: NodeCtor,
  navigator: { userAgent: 'node' },
  location: { href: 'http://127.0.0.1:5190/', origin: 'http://127.0.0.1:5190', protocol: 'http:', host: '127.0.0.1:5190', hostname: '127.0.0.1', port: '5190', pathname: '/', search: '', hash: '' },
  getComputedStyle: () => new Proxy({}, { get: () => '' }),
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  addEventListener() {},
  removeEventListener() {},
  MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
  self: null as unknown as WindowLike,
  top: null as unknown as WindowLike,
  parent: null as unknown as WindowLike,
  frameElement: null,
} as WindowLike;

windowObj.self = windowObj;
windowObj.top = windowObj;
windowObj.parent = windowObj;
document.defaultView = windowObj;

for (const [key, value] of Object.entries({
  window: windowObj,
  document,
  HTMLElement,
  Element,
  SVGElement,
  HTMLIFrameElement,
  HTMLInputElement,
  HTMLTextAreaElement,
  HTMLSelectElement,
  HTMLAnchorElement,
  Node: NodeCtor,
  location: windowObj.location,
  getComputedStyle: windowObj.getComputedStyle,
  requestAnimationFrame: windowObj.requestAnimationFrame,
  cancelAnimationFrame: windowObj.cancelAnimationFrame,
  MutationObserver: windowObj.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  try {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  } catch {
    (globalThis as Record<string, unknown>)[key] = value;
  }
}

export function findAnchors(root: AnyNode): AnyNode[] {
  const found: AnyNode[] = [];
  const walk = (node: AnyNode) => {
    if (node.nodeType === 1 && node.tagName === 'A') found.push(node);
    for (const child of node.childNodes) walk(child);
  };
  walk(root);
  return found;
}
