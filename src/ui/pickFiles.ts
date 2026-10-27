// File picking that works on iPad Safari: the <input> must be in the document
// when it is clicked, or Safari may never report the chosen file.

export function pickFiles(accept: string, opts: { multiple?: boolean; capture?: boolean } = {}): Promise<File[]> {
  return new Promise((resolve) => {
    const i = document.createElement('input');
    i.type = 'file';
    i.accept = accept;
    i.multiple = !!opts.multiple;
    if (opts.capture) i.setAttribute('capture', 'environment');
    // Off-screen but present (display:none inputs are also ignored by some iOS versions).
    Object.assign(i.style, { position: 'fixed', left: '-1000px', top: '0', width: '1px', height: '1px', opacity: '0' });
    let settled = false;
    const finish = (files: File[]) => {
      if (settled) return;
      settled = true;
      i.remove();
      resolve(files);
    };
    i.addEventListener('change', () => finish([...(i.files ?? [])]));
    i.addEventListener('cancel', () => finish([]));
    document.body.append(i);
    i.click();
  });
}

export const pickFile = (accept: string, capture = false) =>
  pickFiles(accept, { capture }).then((f) => f[0] ?? null);
