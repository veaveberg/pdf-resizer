import React, { useRef, useState } from 'react';
import ArrowCounterclockwiseCircleFill from './assets/arrow.counterclockwise.circle.fill.svg?react';

interface FileNameEditorProps {
  value: string;
  originalValue: string;
  onChange: (val: string) => void;
  disabled?: boolean;
  onRestore?: () => void;
}

// --- Token helpers ---
const SIZE_TOKEN = '*size*';
const YYMMDD_TOKEN = '*YYMMDD*';
const DDMMYY_TOKEN = '*DDMMYY*';
const TOKEN_OR_CANDIDATE_REGEX = /(\*size\*|\*YYMMDD\*|\*DDMMYY\*)|(?<!\d)\d+[xх]\d+(?!\d)|(?<!\d)\d{6}(?!\d)|(?<![A-Za-zА-Яа-я0-9])[AА][0-5][hv]?(?![A-Za-zА-Яа-я0-9])/g;

function stringContainsSizePattern(text: string): boolean {
  // Match _100x200_ or _100x200 or 100x200_ or 100x200 (word boundaries)
  const regexSizePattern = /(_\d+[xх]\d+_)|(_\d+[xх]\d+$)|(^\d+[xх]\d+_)|(\b\d+[xх]\d+\b)/;
  if (regexSizePattern.test(text)) return true;
  // A-series: A0-A5 with optional h/v
  const regexPaper = /(^|[_\-\s])[AА][0-5][hv]?($|[_\-\s])/;
  return regexPaper.test(text);
}
function stringContainsDatePattern(text: string): boolean {
  // 6 digit date, not part of a longer number
  return /(?<!\d)\d{6}(?!\d)/.test(text);
}
function replaceSizePattern(text: string, token: string): string {
  let replaced = text
    // Keep separators around the replaced token.
    .replace(/(_)\d+[xх]\d+(_)/g, `$1${token}$2`)
    .replace(/(_)\d+[xх]\d+(?=$)/g, `$1${token}`)
    .replace(/(?<=^)\d+[xх]\d+(_)/g, `${token}$1`)
    .replace(/\b\d+[xх]\d+\b/g, token);
  if (replaced !== text) return replaced;
  // Try A-series and keep separators.
  const regexPaper = /(^|[_\-\s])([AА][0-5][hv]?)($|[_\-\s])/g;
  return text.replace(regexPaper, (_m, left, _paper, right) => `${left}${token}${right}`);
}
function replaceFirstDatePattern(text: string, token: string): string {
  const regex = /(?<!\d)\d{6}(?!\d)/;
  return text.replace(regex, token);
}

function renderHighlightedValue(text: string) {
  const parts: Array<{ text: string; kind: 'normal' | 'token' | 'candidate' }> = [];
  let cursor = 0;
  for (const match of text.matchAll(TOKEN_OR_CANDIDATE_REGEX)) {
    const part = match[0];
    const start = match.index ?? 0;
    const end = start + part.length;
    if (start > cursor) {
      parts.push({ text: text.slice(cursor, start), kind: 'normal' });
    }
    const isToken =
      part === SIZE_TOKEN ||
      part === YYMMDD_TOKEN ||
      part === DDMMYY_TOKEN;
    parts.push({ text: part, kind: isToken ? 'token' : 'candidate' });
    cursor = end;
  }
  if (cursor < text.length) {
    parts.push({ text: text.slice(cursor), kind: 'normal' });
  }

  return parts.map((part, idx) => {
    const isToken = part.kind === 'token';
    const isCandidate = part.kind === 'candidate';
    return (
      <span
        key={`${part.text}-${idx}`}
        style={{
          color: isToken ? 'var(--link-color)' : 'var(--text-color)',
          fontWeight: 400,
          background: isToken
            ? 'color-mix(in srgb, var(--link-color) 14%, transparent)'
            : (isCandidate ? 'var(--filename-candidate-highlight)' : 'transparent'),
          borderRadius: (isToken || isCandidate) ? 4 : 0,
        }}
      >
        {part.text}
      </span>
    );
  });
}

const FileNameEditor: React.FC<FileNameEditorProps> = ({ value, originalValue, onChange, disabled, onRestore }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [inputScrollLeft, setInputScrollLeft] = useState(0);

  // --- Token insert handlers ---
  const insertToken = (token: string) => {
    if (!inputRef.current) return;
    const el = inputRef.current;
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const newValue = value.slice(0, start) + token + value.slice(end);
    onChange(newValue);
    setTimeout(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    }, 0);
  };

  // --- Autoreplace handlers ---
  const handleAutoReplaceSize = () => {
    if (stringContainsSizePattern(value)) {
      onChange(replaceSizePattern(value, SIZE_TOKEN));
    }
  };
  const handleAutoReplaceDate = (token: string) => {
    if (stringContainsDatePattern(value)) {
      onChange(replaceFirstDatePattern(value, token));
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', width: 400, maxWidth: '100%', margin: '24px auto 0 auto' }}>
      <label style={{ fontWeight: 500, fontSize: 16, marginBottom: 6, color: 'var(--text-color)' }}>Filename:</label>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <div
          style={{
            position: 'relative',
            width: 400,
            minWidth: 0,
            borderRadius: 8,
            border: '1px solid var(--input-border)',
            background: 'var(--input-bg)',
            boxSizing: 'border-box',
          }}
        >
          <div
            style={{
              position: 'absolute',
              inset: 0,
              overflow: 'hidden',
              borderRadius: 8,
              pointerEvents: 'none',
            }}
          >
          <div
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              padding: '6px 10px',
              fontFamily: 'inherit',
              fontSize: 16,
              fontWeight: 400,
              lineHeight: '22px',
              letterSpacing: 'inherit',
              whiteSpace: 'pre',
              boxSizing: 'border-box',
              transform: `translateX(${-inputScrollLeft}px)`,
            }}
          >
            {renderHighlightedValue(value)}
          </div>
          </div>
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={e => onChange(e.target.value)}
            onScroll={e => setInputScrollLeft(e.currentTarget.scrollLeft)}
            disabled={disabled}
            style={{
              width: '100%',
              fontFamily: 'inherit',
              fontSize: 16,
              fontWeight: 400,
              lineHeight: '22px',
              letterSpacing: 'inherit',
              padding: '6px 10px',
              borderRadius: 8,
              border: 'none',
              background: 'transparent',
              color: 'transparent',
              caretColor: 'var(--text-color)',
              minWidth: 0,
              boxSizing: 'border-box',
              transition: 'border 0.2s',
              position: 'relative',
              zIndex: 1,
            }}
            spellCheck={false}
          />
        </div>
        {value !== originalValue && !disabled && (
          <button
            type="button"
            onClick={() => {
              onRestore && onRestore();
              setTimeout(() => inputRef.current?.focus(), 0);
            }}
            style={{
              marginLeft: 8,
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              color: 'var(--secondary-color)',
              display: 'flex',
              alignItems: 'center',
              fontSize: 20,
            }}
            title="Restore original filename"
          >
            <ArrowCounterclockwiseCircleFill style={{ width: 22, height: 22, display: 'block' }} />
          </button>
        )}
      </div>
      {/* Token hint row and autoreplace buttons */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, width: '100%' }}>
        <span style={{ fontSize: 13, color: 'var(--secondary-color)' }}>Insert:</span>
        <button type="button" style={{ fontSize: 13, color: 'var(--link-color)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px', borderRadius: 4 }} onClick={() => insertToken(SIZE_TOKEN)}>{SIZE_TOKEN}</button>
        <button type="button" style={{ fontSize: 13, color: 'var(--link-color)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px', borderRadius: 4 }} onClick={() => insertToken(YYMMDD_TOKEN)}>{YYMMDD_TOKEN}</button>
        <button type="button" style={{ fontSize: 13, color: 'var(--link-color)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px', borderRadius: 4 }} onClick={() => insertToken(DDMMYY_TOKEN)}>{DDMMYY_TOKEN}</button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 2, width: '100%' }}>
        <span style={{ fontSize: 13, color: 'var(--secondary-color)' }}>Autoreplace:</span>
        <button type="button"
          style={{ fontSize: 13, color: stringContainsSizePattern(value) ? 'var(--link-color)' : 'var(--secondary-color)', background: 'none', border: '1px solid var(--divider)', cursor: stringContainsSizePattern(value) ? 'pointer' : 'not-allowed', padding: '2px 8px', borderRadius: 4 }}
          disabled={!stringContainsSizePattern(value)}
          onClick={handleAutoReplaceSize}
        >Size</button>
        <button type="button"
          style={{ fontSize: 13, color: stringContainsDatePattern(value) ? 'var(--link-color)' : 'var(--secondary-color)', background: 'none', border: '1px solid var(--divider)', cursor: stringContainsDatePattern(value) ? 'pointer' : 'not-allowed', padding: '2px 8px', borderRadius: 4 }}
          disabled={!stringContainsDatePattern(value)}
          onClick={() => handleAutoReplaceDate(YYMMDD_TOKEN)}
        >YYMMDD</button>
        <button type="button"
          style={{ fontSize: 13, color: stringContainsDatePattern(value) ? 'var(--link-color)' : 'var(--secondary-color)', background: 'none', border: '1px solid var(--divider)', cursor: stringContainsDatePattern(value) ? 'pointer' : 'not-allowed', padding: '2px 8px', borderRadius: 4 }}
          disabled={!stringContainsDatePattern(value)}
          onClick={() => handleAutoReplaceDate(DDMMYY_TOKEN)}
        >DDMMYY</button>
      </div>
    </div>
  );
};

export default FileNameEditor; 
