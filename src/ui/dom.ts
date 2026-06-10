/** Creates a DOM element with optional Tailwind classes and children. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const c of children) {
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

export type BtnVariant = "primary" | "secondary" | "danger" | "ghost";

const BTN_BASE =
  "text-xs font-mono rounded transition-colors duration-150 " +
  "disabled:opacity-40 disabled:pointer-events-none";

const BTN_STYLE: Record<BtnVariant, string> = {
  primary:   "bg-blue-700 hover:bg-blue-600 text-white px-2.5 py-1 cursor-pointer",
  secondary: "border border-amber-600 text-amber-400 hover:bg-amber-600/20 px-2.5 py-1 cursor-pointer",
  danger:    "text-red-800 hover:text-red-500 px-1.5 py-0.5 cursor-pointer",
  ghost:     "text-gray-500 hover:text-gray-300 px-2 py-0.5 cursor-pointer",
};

export function btn(variant: BtnVariant, label: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = `${BTN_BASE} ${BTN_STYLE[variant]}`;
  b.textContent = label;
  return b;
}
