// Inline art for the landing page. Pure markup: all motion lives in css/landing.css and is driven by data-p / .live on the root.
import { raw } from '../lib.js';

const bars = [5, 8, 11, 14, 16, 15, 13, 10, 8, 6, 5, 4].map((h, i) => `<rect class="b" style="--i:${i}" x="${232 + i * 14}" y="${215 - h}" width="9" height="${h}" rx="2"/>`).join('');
const cells = [0, 1, 2].map((r) => [0, 1, 2, 3].map((c) => `<rect x="${30 + c * 30 + r * 7}" y="${192 + r * 18}" width="27" height="15" rx="2" fill="url(#sbCell)" transform="skewX(0)"/>`).join('')).join('');
const lock = (s = 1) => `<g fill="none" stroke="currentColor" stroke-width="${2.2 / s}" stroke-linecap="round" stroke-linejoin="round"><rect x="-6" y="-1" width="12" height="9" rx="2"/><path d="M-3.6 -1v-3a3.6 3.6 0 017.2 0v3"/></g>`;
const chip = (i, t) => `<g class="chip c${i}" style="--i:${i}" transform="translate(414 ${142 + i * 38})"><g class="chip-m"><rect class="chip-bg" width="64" height="27" rx="8"/><circle cx="12" cy="13.5" r="4.4" class="chip-sun"/><text x="21" y="17.5" class="mono chip-t">${t}</text><g class="chip-lock" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="51" y="13" width="8" height="6.5" rx="1.5"/><path d="M52.8 13v-2a2.2 2.2 0 014.4 0v2"/></g></g></g>`;
const check = (i, label) => `<g class="ck" style="--i:${i}" transform="translate(498 ${164 + i * 36})"><circle class="ck-c" r="9" cx="9" cy="9"/><path class="ck-t" d="M4.6 9.4l3 3 5.6-6"/><text x="26" y="13.5" class="ck-l">${label}</text></g>`;

export const sunboxArt = raw(`<svg class="sbx-svg" viewBox="0 0 640 340" role="img" aria-labelledby="sbx-t sbx-d" preserveAspectRatio="xMidYMid meet">
<title id="sbx-t">The SunBox sending a signed reading to the SunCredit registry</title>
<desc id="sbx-d">A small green box next to a solar panel reads solar output, signs the hourly reading with a seal, and sends it by radio to the registry, which checks the signature, that it is not a repeat, and that the values are in range.</desc>
<defs>
 <linearGradient id="sbBody" x1="0" y1="0" x2=".6" y2="1"><stop offset="0" stop-color="#3f8d66"/><stop offset=".45" stop-color="#1f5b3f"/><stop offset="1" stop-color="#0f3325"/></linearGradient>
 <linearGradient id="sbGloss" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".3"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
 <linearGradient id="sbCell" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3d74b6"/><stop offset="1" stop-color="#12305a"/></linearGradient>
 <linearGradient id="sbRod" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#0d241a"/><stop offset=".5" stop-color="#4a8a6b"/><stop offset="1" stop-color="#0d241a"/></linearGradient>
 <radialGradient id="sbSeal" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#ffe9a6"/><stop offset="1" stop-color="#f0a52a"/></radialGradient>
 <radialGradient id="sbBall" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#a6f3c8"/><stop offset="1" stop-color="#1f5b3f"/></radialGradient>
 <filter id="sbBlur" x="-20%" y="-20%" width="140%" height="160%"><feGaussianBlur stdDeviation="9"/></filter>
</defs>
<g aria-hidden="true">
 <!-- solar panel + sun -->
 <g class="sbx-sun" transform="translate(70 88)"><g class="rays"><circle r="24" fill="#ffd36b"/><g stroke="#f0a52a" stroke-width="5" stroke-linecap="round"><path d="M0 -38v-10M0 38v10M-38 0h-10M38 0h10M-27 -27l-7 -7M27 27l7 7M-27 27l-7 7M27 -27l7 -7"/></g></g></g>
 <path d="M52 276l-8 40M128 276l8 40M34 316h120" stroke="#10261d" stroke-width="5" stroke-linecap="round" fill="none"/>
 <g transform="translate(0 0)"><path d="M20 266l22-84h122l-12 84z" fill="#cfd9d3" stroke="#10261d" stroke-width="4" stroke-linejoin="round"/>
  <g transform="translate(-8 -4)" opacity=".98">${cells}</g><path d="M20 266l22-84h122l-12 84z" fill="url(#sbGloss)" opacity=".5"/></g>
 <!-- cable -->
 <path d="M150 248C168 248 176 236 204 236" stroke="#c9831a" stroke-width="7" stroke-linecap="round" fill="none"/>
 <path class="cur" d="M150 248C168 248 176 236 204 236" stroke="#ffe08a" stroke-width="3" stroke-linecap="round" stroke-dasharray="4 12" fill="none"/>
 <!-- packets (behind box and registry so they slide out of one and into the other) -->
 ${chip(0, '10:00')}${chip(1, '11:00')}${chip(2, '12:00')}
 <!-- registry -->
 <g class="reg"><rect x="480" y="104" width="152" height="190" rx="16" class="reg-bg"/><text x="498" y="134" class="reg-t">SunCredit</text><text x="498" y="150" class="mono reg-s">REGISTRY</text>
  ${check(0, 'Signature')}${check(1, 'Not a repeat')}${check(2, 'In range')}</g>
 <!-- radio waves -->
 <g class="waves"><circle class="w" style="--i:0" cx="385" cy="60" r="14"/><circle class="w" style="--i:1" cx="385" cy="60" r="14"/><circle class="w" style="--i:2" cx="385" cy="60" r="14"/></g>
 <!-- SunBox -->
 <ellipse cx="310" cy="302" rx="124" ry="12" fill="#10261d" opacity=".35" filter="url(#sbBlur)"/>
 <rect x="380" y="62" width="11" height="68" rx="5.5" fill="url(#sbRod)"/><circle cx="385.5" cy="58" r="11" fill="url(#sbBall)"/>
 <g class="body"><rect x="200" y="118" width="226" height="178" rx="28" fill="url(#sbBody)"/><path d="M200 146a28 28 0 0128-28h170a28 28 0 0128 28v8c-40 30-186 30-226 0z" fill="url(#sbGloss)"/>
  <g fill="#cfd9d3"><circle cx="216" cy="134" r="4.6"/><circle cx="410" cy="134" r="4.6"/><circle cx="216" cy="280" r="4.6"/><circle cx="410" cy="280" r="4.6"/></g>
  <text x="228" y="150" class="disp bx-name">SunBox</text><text x="396" y="148" text-anchor="end" class="mono bx-id">SB-1004</text>
  <rect x="222" y="160" width="182" height="62" rx="11" fill="#06130e" stroke="#0b2a1d" stroke-width="3"/>
  <rect class="scr-glow" x="224" y="162" width="178" height="58" rx="9"/>
  <text x="234" y="176" class="mono scr-l">HOURLY READING</text>
  <g class="vals"><text class="mono v v1" x="234" y="196">10:00</text><text class="mono v v2" x="234" y="196">11:00</text><text class="mono v v3" x="234" y="196">12:00</text><text class="mono v v5" x="234" y="196">SENDING</text><text class="mono v v6" x="234" y="196">SENT</text><text class="mono v v4" x="234" y="196">SIGNED</text></g>
  <g class="bars" clip-path="inset(0)">${bars}</g><rect class="scan" x="224" y="162" width="3" height="58"/>
  <g class="leds"><circle class="led l1" cx="236" cy="252" r="6.5"/><circle class="led l2" cx="256" cy="252" r="6.5"/><circle class="led l3" cx="276" cy="252" r="6.5"/></g>
  <g fill="#000" opacity=".3"><rect x="326" y="244" width="60" height="5" rx="2.5"/><rect x="326" y="254" width="60" height="5" rx="2.5"/><rect x="326" y="264" width="60" height="5" rx="2.5"/></g>
 </g>
 <g class="seal" transform="translate(396 272)"><g class="seal-m"><circle r="24" fill="url(#sbSeal)" stroke="#c9831a" stroke-width="5"/><g color="#10261d" transform="scale(1.35)">${lock(1.35)}</g></g></g>
</g></svg>`);

// Hero: a low sun on a dotted arc over a horizon. The sun rises once, then breathes.
export const heroSun = raw(`<svg class="hsun" viewBox="0 0 480 280" fill="none" aria-hidden="true" focusable="false">
<defs><radialGradient id="hsGlow" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="oklch(86% 0.14 78)" stop-opacity=".8"/><stop offset="1" stop-color="oklch(86% 0.14 78)" stop-opacity="0"/></radialGradient></defs>
<path class="a1" d="M24 262C66 112 168 34 256 34s170 80 200 228" stroke="oklch(84% 0.1 80)" stroke-width="1.6" stroke-dasharray="3 7"/>
<path class="a2" d="M70 262C102 150 180 82 256 82s144 68 176 180" stroke="oklch(90% 0.07 85)" stroke-width="1.6"/>
<g class="sunrise"><circle class="glow" cx="372" cy="88" r="84" fill="url(#hsGlow)"/><g class="halo"><circle cx="372" cy="88" r="50" stroke="oklch(79% 0.165 74)" stroke-opacity=".4" stroke-width="1.5"/></g><circle cx="372" cy="88" r="30" fill="oklch(79% 0.165 74)"/></g>
</svg>`);
