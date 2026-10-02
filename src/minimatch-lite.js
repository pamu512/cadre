// minimatch-lite - the subset of glob matching cadre needs, zero deps.
// Supports: * (within segment), ** (across segments), ? (one char).
// Not supported (on purpose): extglobs, braces, negation (use exclusions).
function segToRx(seg) {
  let rx = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === '*') {
      if (seg[i + 1] === '*') { i++; continue; } // ** handled at pattern level
      rx += '[^/]*';
    } else if (c === '?') rx += '[^/]';
    else rx += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return rx;
}

export function minimatch(path, pattern) {
  const p = String(path).replace(/^\.\//, '');
  const pat = String(pattern).replace(/^\.\//, '');
  const patSegs = pat.split('/');
  const pSegs = p.split('/');

  // build a regex: ** matches any number of segments
  let rx = '^';
  let i = 0;
  while (i < patSegs.length) {
    if (patSegs[i] === '**') {
      // consecutive ** collapse; match zero or more segments
      while (patSegs[i] === '**') i++;
      if (i >= patSegs.length) { rx += '.*'; break; }
      rx += '(?:[^/]+/)*';
    } else {
      rx += segToRx(patSegs[i]);
      if (i < patSegs.length - 1) rx += '/';
      i++;
    }
  }
  rx += '$';
  // pattern with fewer segments than path only matches if it ends with **
  try { return new RegExp(rx).test(p); } catch { return false; }
}
