import React, { useRef, useLayoutEffect, useState, useEffect } from 'react';

const MODES = [
  { label: 'Fill', value: 'fill' },
  { label: 'Set Width', value: 'fitHeight' },
  { label: 'Set Height', value: 'fitWidth' },
  { label: 'Scale', value: 'scale' },
];

function formatMMInput(val: string | number) {
  if (typeof val === 'number') val = val.toString();
  val = val.replace('.', ',');
  const match = val.match(/^(\d+)([.,])?(\d{0,2})?$/);
  if (!match) return val;
  let result = match[1];
  if (typeof match[2] !== 'undefined') result += ',';
  if (typeof match[3] !== 'undefined') result += match[3];
  return result;
}

function formatScaleInput(val: string | number) {
  if (typeof val === 'number') {
    return val
      .toFixed(3)
      .replace(/\.0+$/, '')
      .replace(/(\.\d*?)0+$/, '$1')
      .replace('.', ',');
  }
  let next = val.replace('.', ',').replace(/[^\d,]/g, '');
  const parts = next.split(',');
  if (parts.length > 2) next = `${parts[0]},${parts.slice(1).join('')}`;
  return next.replace(/(\d+,\d{0,3}).*/, '$1');
}

export default function SizeAdjusterCard({
  adjuster,
  onChange,
  onRemove,
  isRemovable,
  aspectRatio,
  sourceSizeMm,
  pdfMaxDimensionMm,
  pdfMinDimensionMm,
  sessionScaleFactor,
  onSessionScaleFactorChange,
  SwapIcon,
  RemoveIcon,
  onFocus,
  onBlur,
  presets,
  onEditPresets,
}: any) {
  const { mode, width, height } = adjuster;
  const isPng = adjuster.kind === 'png';
  const isSingleAxisMode = mode === 'fitHeight' || mode === 'fitWidth';
  const ppi = Math.max(1, Number(adjuster.ppi ?? 300));
  const marginMm = Math.max(0, Number(adjuster.marginMm ?? 0));
  const paddingMode = adjuster.paddingMode === 'outside' ? 'outside' : 'inside';
  const scaleFactor = Math.max(0.01, Number(adjuster.scaleFactor ?? sessionScaleFactor ?? 1));
  const insideWidthMm = Math.max(1, Math.max(1, Number(width)) - 2 * marginMm);
  const insideHeightMm = Math.max(1, Math.max(1, Number(height)) - 2 * marginMm);
  const outsideWidthMm = Math.max(1, Number(width)) + 2 * marginMm;
  const outsideHeightMm = Math.max(1, Number(height)) + 2 * marginMm;

  const sourceWidthForFit = Number(sourceSizeMm?.width);
  const sourceHeightForFit = Number(sourceSizeMm?.height);
  const hasSourceForFit = Number.isFinite(sourceWidthForFit) && Number.isFinite(sourceHeightForFit) && sourceWidthForFit > 0 && sourceHeightForFit > 0;

  const sourceWidthMm = hasSourceForFit ? sourceWidthForFit : Number(width);
  const sourceHeightMm = hasSourceForFit ? sourceHeightForFit : Number(height);

  const minScale = hasSourceForFit
    ? Math.max(Number(pdfMinDimensionMm) / sourceWidthMm, Number(pdfMinDimensionMm) / sourceHeightMm)
    : 0.01;
  const maxScale = hasSourceForFit
    ? Math.min(Number(pdfMaxDimensionMm) / sourceWidthMm, Number(pdfMaxDimensionMm) / sourceHeightMm)
    : 100;

  const sourceWidthIn = Number.isFinite(Number(adjuster.pngSourceWidthMm)) && Number(adjuster.pngSourceWidthMm) > 0
    ? Number(adjuster.pngSourceWidthMm) / 25.4
    : Math.max(1, Number(width)) / ppi;
  const sourceHeightIn = Number.isFinite(Number(adjuster.pngSourceHeightMm)) && Number(adjuster.pngSourceHeightMm) > 0
    ? Number(adjuster.pngSourceHeightMm) / 25.4
    : Math.max(1, Number(height)) / ppi;

  function clampScale(nextScale: number) {
    return Math.min(Math.max(nextScale, minScale), maxScale);
  }

  function formatValue(val: number) {
    if (!Number.isFinite(val)) return '';
    if (isPng) return Math.round(val).toString();
    return val
      .toFixed(2)
      .replace(/\.00$/, '')
      .replace(/(\.\d)0$/, '$1')
      .replace('.', ',');
  }

  function formatValueInput(val: string | number) {
    if (isPng) {
      if (typeof val === 'number') return Math.round(val).toString();
      return val.replace(/[^\d]/g, '');
    }
    return formatMMInput(val);
  }

  function formatPpi(val: number) {
    if (!Number.isFinite(val)) return '';
    return val.toFixed(2).replace('.', ',').replace(/,00$/, '').replace(/(,\d)0$/, '$1');
  }

  function formatPpiInput(val: string | number) {
    if (typeof val === 'number') return formatPpi(val);
    let next = val.replace('.', ',').replace(/[^\d,]/g, '');
    const parts = next.split(',');
    if (parts.length > 2) next = `${parts[0]},${parts.slice(1).join('')}`;
    return next.replace(/(\d+,\d{0,2}).*/, '$1');
  }

  const [widthInput, setWidthInput] = useState(formatValueInput(width));
  const [heightInput, setHeightInput] = useState(formatValueInput(height));
  const [ppiInput, setPpiInput] = useState(formatPpiInput(ppi));
  const [marginInput, setMarginInput] = useState(formatMMInput(marginMm));
  const [scaleInput, setScaleInput] = useState(formatScaleInput(scaleFactor));
  const [scaleUnit, setScaleUnit] = useState<'factor' | 'percent'>('factor');

  const maxMarginMm = Math.max(0, (Math.min(Number(width), Number(height)) - Number(pdfMinDimensionMm ?? 0)) / 2);

  React.useEffect(() => {
    setWidthInput(formatValueInput(width));
  }, [width, isPng]);

  React.useEffect(() => {
    setHeightInput(formatValueInput(height));
  }, [height, isPng]);

  React.useEffect(() => {
    setPpiInput(formatPpiInput(ppi));
  }, [ppi, isPng]);

  React.useEffect(() => {
    setMarginInput(formatMMInput(marginMm));
  }, [marginMm]);

  React.useEffect(() => {
    const display = scaleUnit === 'percent' ? scaleFactor * 100 : scaleFactor;
    setScaleInput(formatScaleInput(display));
  }, [scaleFactor, scaleUnit]);

  function parseInput(val: string) {
    if (isPng) return Number(val);
    return Number(val.replace(',', '.'));
  }

  const handlePreset = (preset: any) => {
    const pdfW = aspectRatio ? aspectRatio : 1;
    const pdfPortrait = pdfW <= 1;
    const presetPortrait = preset.width <= preset.height;
    let nextWidth = preset.width;
    let nextHeight = preset.height;
    if (pdfPortrait !== presetPortrait) {
      nextWidth = preset.height;
      nextHeight = preset.width;
    }
    if (mode === 'fitHeight' && sourceWidthMm > 0) {
      onChange({
        ...adjuster,
        width: nextWidth,
        height: Number((nextWidth * (sourceHeightMm / sourceWidthMm)).toFixed(2)),
        source: 'manual',
      });
      return;
    }
    if (mode === 'fitWidth' && sourceHeightMm > 0) {
      onChange({
        ...adjuster,
        height: nextHeight,
        width: Number((nextHeight * (sourceWidthMm / sourceHeightMm)).toFixed(2)),
        source: 'manual',
      });
      return;
    }
    if (mode === 'scale' && sourceWidthMm > 0) {
      applyFitScale(nextWidth / sourceWidthMm);
      return;
    }
    onChange({ ...adjuster, width: nextWidth, height: nextHeight, mode: 'fill', source: 'manual' });
  };

  const applyPngScale = (changedField: 'width' | 'height' | 'ppi', nextRaw: number) => {
    const nextValue = Math.max(1, Number(nextRaw));
    const nextPpi = changedField === 'width'
      ? nextValue / sourceWidthIn
      : changedField === 'height'
        ? nextValue / sourceHeightIn
        : nextValue;
    const normalizedPpi = Math.max(1, Number(nextPpi.toFixed(2)));

    onChange({
      ...adjuster,
      width: Math.max(1, Math.round(sourceWidthIn * normalizedPpi)),
      height: Math.max(1, Math.round(sourceHeightIn * normalizedPpi)),
      ppi: normalizedPpi,
      pngLockField: changedField,
      source: 'manual',
    });
  };

  const applyFitScale = (nextRawScale: number) => {
    const clamped = clampScale(Math.max(0.01, Number(nextRawScale)));
    const nextWidth = Number((sourceWidthMm * clamped).toFixed(2));
    const nextHeight = Number((sourceHeightMm * clamped).toFixed(2));
    onSessionScaleFactorChange?.(clamped);
    onChange({
      ...adjuster,
      mode: 'scale',
      scaleFactor: clamped,
      width: nextWidth,
      height: nextHeight,
      source: 'manual',
    });
  };

  const handleMode = (newMode: any) => {
    if (newMode === 'scale') {
      applyFitScale(scaleFactor);
      return;
    }
    if (newMode === 'fitHeight' && sourceHeightMm > 0) {
      onChange({
        ...adjuster,
        mode: newMode,
        height: Number((Number(width) * (sourceHeightMm / sourceWidthMm)).toFixed(2)),
        source: 'manual',
      });
      return;
    }
    if (newMode === 'fitWidth' && sourceHeightMm > 0) {
      onChange({
        ...adjuster,
        mode: newMode,
        width: Number((Number(height) * (sourceWidthMm / sourceHeightMm)).toFixed(2)),
        source: 'manual',
      });
      return;
    }
    onChange({ ...adjuster, mode: newMode });
  };

  const handleWidth = (e: any) => {
    let val = e.target.value.replace(isPng ? /[^\d]/g : /[^\d.,]/g, '');
    if (!isPng) val = val.replace(/(\d+[.,]\d{0,2}).*/, '$1');
    setWidthInput(val);

    const valid = isPng ? /^\d*$/.test(val) : /^\d*[.,]?\d{0,2}$/.test(val);
    if (!valid) return;
    const w = parseInput(val);
    if (!isNaN(w) && val !== '' && val !== '.' && val !== ',') {
      if (isPng) {
        applyPngScale('width', w);
      } else if (mode === 'scale' && hasSourceForFit) {
        applyFitScale(w / sourceWidthMm);
      } else if (mode === 'fitHeight' && sourceWidthMm > 0) {
        onChange({
          ...adjuster,
          width: w,
          height: Number((w * (sourceHeightMm / sourceWidthMm)).toFixed(2)),
          source: 'manual',
        });
      } else {
        onChange({ ...adjuster, width: w, source: 'manual' });
      }
    }
  };

  const handleHeight = (e: any) => {
    let val = e.target.value.replace(isPng ? /[^\d]/g : /[^\d.,]/g, '');
    if (!isPng) val = val.replace(/(\d+[.,]\d{0,2}).*/, '$1');
    setHeightInput(val);

    const valid = isPng ? /^\d*$/.test(val) : /^\d*[.,]?\d{0,2}$/.test(val);
    if (!valid) return;
    const h = parseInput(val);
    if (!isNaN(h) && val !== '' && val !== '.' && val !== ',') {
      if (isPng) {
        applyPngScale('height', h);
      } else if (mode === 'scale' && hasSourceForFit) {
        applyFitScale(h / sourceHeightMm);
      } else if (mode === 'fitWidth' && sourceHeightMm > 0) {
        onChange({
          ...adjuster,
          height: h,
          width: Number((h * (sourceWidthMm / sourceHeightMm)).toFixed(2)),
          source: 'manual',
        });
      } else {
        onChange({ ...adjuster, height: h, source: 'manual' });
      }
    }
  };

  const handlePpi = (e: any) => {
    const val = formatPpiInput(e.target.value);
    setPpiInput(val);
    if (!/^\d*,?\d{0,2}$/.test(val)) return;
    const p = Number(val.replace(',', '.'));
    if (!isNaN(p) && val !== '') applyPngScale('ppi', p);
  };

  const handleMargin = (e: any) => {
    let val = e.target.value.replace(/[^\d.,]/g, '');
    val = val.replace(/(\d+[.,]\d{0,2}).*/, '$1');
    setMarginInput(val);
    if (!/^\d*[.,]?\d{0,2}$/.test(val)) return;
    const parsed = Number(val.replace(',', '.'));
    if (!isNaN(parsed) && val !== '' && val !== '.' && val !== ',') {
      const nextMargin = Math.min(Math.max(parsed, 0), maxMarginMm);
      onChange({ ...adjuster, marginMm: Number(nextMargin.toFixed(2)), source: 'manual' });
    }
  };

  const handleScale = (e: any) => {
    const val = formatScaleInput(e.target.value);
    setScaleInput(val);
    if (!/^\d*[.,]?\d{0,3}$/.test(val)) return;
    const parsed = Number(val.replace(',', '.'));
    if (!isNaN(parsed) && parsed > 0) {
      const nextScale = scaleUnit === 'percent' ? parsed / 100 : parsed;
      applyFitScale(nextScale);
    }
  };

  const handleWidthBlur = () => {
    const w = parseInput(widthInput);
    setWidthInput(Number.isFinite(w) ? formatValue(w) : '');
  };

  const handleHeightBlur = () => {
    const h = parseInput(heightInput);
    setHeightInput(Number.isFinite(h) ? formatValue(h) : '');
  };

  const handlePpiBlur = () => {
    const p = Number(ppiInput.replace(',', '.'));
    setPpiInput(Number.isFinite(p) ? formatPpi(p) : '');
  };

  const handleMarginBlur = () => {
    const p = Number(marginInput.replace(',', '.'));
    if (!Number.isFinite(p)) {
      setMarginInput('0');
      return;
    }
    const nextMargin = Math.min(Math.max(p, 0), maxMarginMm);
    setMarginInput(formatMMInput(nextMargin));
  };

  const handleScaleBlur = () => {
    const parsed = Number(scaleInput.replace(',', '.'));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      const fallback = scaleUnit === 'percent' ? scaleFactor * 100 : scaleFactor;
      setScaleInput(formatScaleInput(fallback));
      return;
    }
    const rawScale = scaleUnit === 'percent' ? parsed / 100 : parsed;
    const nextScale = clampScale(rawScale);
    const nextDisplay = scaleUnit === 'percent' ? nextScale * 100 : nextScale;
    setScaleInput(formatScaleInput(nextDisplay));
    applyFitScale(nextScale);
  };

  const handleScaleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    let displayValue = Number(scaleInput.replace(',', '.'));
    if (!Number.isFinite(displayValue) || displayValue <= 0) {
      displayValue = scaleUnit === 'percent' ? scaleFactor * 100 : scaleFactor;
    }
    const baseStep = scaleUnit === 'percent' ? 1 : 0.1;
    const step = e.shiftKey ? baseStep * 10 : baseStep;
    const minDisplay = scaleUnit === 'percent' ? 10 : 0.1;
    let nextDisplayRaw = displayValue;
    if (e.key === 'ArrowUp') {
      nextDisplayRaw = Math.ceil(displayValue / step) * step;
      if (Math.abs(nextDisplayRaw - displayValue) < 1e-9) nextDisplayRaw += step;
    } else {
      nextDisplayRaw = Math.floor(displayValue / step) * step;
      if (Math.abs(nextDisplayRaw - displayValue) < 1e-9) nextDisplayRaw -= step;
    }
    nextDisplayRaw = Math.max(minDisplay, nextDisplayRaw);
    const nextScaleRaw = scaleUnit === 'percent' ? nextDisplayRaw / 100 : nextDisplayRaw;
    const nextScale = clampScale(Math.max(0.0001, nextScaleRaw));
    const nextDisplay = scaleUnit === 'percent' ? nextScale * 100 : nextScale;
    setScaleInput(formatScaleInput(nextDisplay));
    applyFitScale(nextScale);
    e.preventDefault();
  };

  const handleScaleUnit = (nextUnit: 'factor' | 'percent') => {
    if (nextUnit === scaleUnit) return;
    const parsed = Number(scaleInput.replace(',', '.'));
    const base = Number.isFinite(parsed) && parsed > 0
      ? parsed
      : (scaleUnit === 'percent' ? scaleFactor * 100 : scaleFactor);
    const converted = nextUnit === 'percent' ? base * 100 : base / 100;
    setScaleUnit(nextUnit);
    setScaleInput(formatScaleInput(converted));
  };

  const handleMarginKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    let m = Number(marginInput.replace(',', '.'));
    if (!Number.isFinite(m)) m = 0;
    let next = m;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (e.shiftKey) {
        if (e.key === 'ArrowUp') {
          next = Math.ceil(m / 10) * 10;
          if (next === m) next += 10;
        } else {
          next = Math.floor(m / 10) * 10;
          if (next === m) next -= 10;
          if (next < 0) next = 0;
        }
      } else {
        if (e.key === 'ArrowUp') {
          next = Math.ceil(m);
          if (next === m) next += 1;
        } else {
          next = Math.floor(m);
          if (next === m) next -= 1;
          if (next < 0) next = 0;
        }
      }
      next = Math.min(Math.max(next, 0), maxMarginMm);
      setMarginInput(formatMMInput(next));
      onChange({ ...adjuster, marginMm: Number(next.toFixed(2)), source: 'manual' });
      e.preventDefault();
    }
  };

  const handleWidthKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    let w = parseInput(widthInput);
    if (!Number.isFinite(w)) w = 0;
    let next = w;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (e.shiftKey) {
        if (e.key === 'ArrowUp') {
          next = Math.ceil(w / 10) * 10;
          if (next === w) next += 10;
        } else {
          next = Math.floor(w / 10) * 10;
          if (next === w) next -= 10;
          if (next < 1) next = 1;
        }
      } else {
        if (e.key === 'ArrowUp') {
          next = Math.ceil(w);
          if (next === w) next += 1;
        } else {
          next = Math.floor(w);
          if (next === w) next -= 1;
          if (next < 1) next = 1;
        }
      }
      setWidthInput(formatValueInput(next));
      if (isPng) {
        applyPngScale('width', next);
      } else if (mode === 'scale' && hasSourceForFit) {
        applyFitScale(next / sourceWidthMm);
      } else if (mode === 'fitHeight' && sourceWidthMm > 0) {
        onChange({
          ...adjuster,
          width: next,
          height: Number((next * (sourceHeightMm / sourceWidthMm)).toFixed(2)),
          source: 'manual',
        });
      } else {
        onChange({ ...adjuster, width: next, source: 'manual' });
      }
      e.preventDefault();
    }
  };

  const handleHeightKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    let h = parseInput(heightInput);
    if (!Number.isFinite(h)) h = 0;
    let next = h;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (e.shiftKey) {
        if (e.key === 'ArrowUp') {
          next = Math.ceil(h / 10) * 10;
          if (next === h) next += 10;
        } else {
          next = Math.floor(h / 10) * 10;
          if (next === h) next -= 10;
          if (next < 1) next = 1;
        }
      } else {
        if (e.key === 'ArrowUp') {
          next = Math.ceil(h);
          if (next === h) next += 1;
        } else {
          next = Math.floor(h);
          if (next === h) next -= 1;
          if (next < 1) next = 1;
        }
      }
      setHeightInput(formatValueInput(next));
      if (isPng) {
        applyPngScale('height', next);
      } else if (mode === 'scale' && hasSourceForFit) {
        applyFitScale(next / sourceHeightMm);
      } else if (mode === 'fitWidth' && sourceHeightMm > 0) {
        onChange({
          ...adjuster,
          height: next,
          width: Number((next * (sourceWidthMm / sourceHeightMm)).toFixed(2)),
          source: 'manual',
        });
      } else {
        onChange({ ...adjuster, height: next, source: 'manual' });
      }
      e.preventDefault();
    }
  };

  const handlePpiKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    let p = Number(ppiInput.replace(',', '.'));
    if (!Number.isFinite(p)) p = 0;
    let next = p;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (e.shiftKey) {
        if (e.key === 'ArrowUp') {
          next = Math.ceil(p / 10) * 10;
          if (next === p) next += 10;
        } else {
          next = Math.floor(p / 10) * 10;
          if (next === p) next -= 10;
          if (next < 1) next = 1;
        }
      } else {
        if (e.key === 'ArrowUp') {
          next = Math.ceil(p);
          if (next === p) next += 1;
        } else {
          next = Math.floor(p);
          if (next === p) next -= 1;
          if (next < 1) next = 1;
        }
      }
      setPpiInput(formatPpiInput(next));
      applyPngScale('ppi', next);
      e.preventDefault();
    }
  };

  const handleSwap = () => {
    onChange({ ...adjuster, width: height, height: width, source: 'manual' });
  };

  const segmentedRef = useRef<HTMLDivElement>(null);
  const [thumbStyle, setThumbStyle] = useState({ left: 0, width: 0 });
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const updateSegmentThumb = () => {
    if (isPng) return;
    const idx = MODES.findIndex(m => m.value === mode);
    if (idx < 0 || !segmentedRef.current || !buttonRefs.current[idx]) return;
    const containerRect = segmentedRef.current.getBoundingClientRect();
    const btnRect = buttonRefs.current[idx]!.getBoundingClientRect();
    setThumbStyle({
      left: Math.max(0, btnRect.left - containerRect.left),
      width: Math.max(0, Math.min(btnRect.width, containerRect.width)),
    });
  };

  useLayoutEffect(() => {
    updateSegmentThumb();
  }, [mode, isPng]);

  useEffect(() => {
    if (isPng || !segmentedRef.current) return;
    const onResize = () => updateSegmentThumb();
    window.addEventListener('resize', onResize);
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(onResize);
      observer.observe(segmentedRef.current);
    }
    return () => {
      window.removeEventListener('resize', onResize);
      observer?.disconnect();
    };
  }, [isPng, mode]);

  return (
    <div style={{ display: 'flex', alignItems: 'center', width: 400, margin: '0 auto', marginBottom: 10 }}>
      <div style={{
        background: 'var(--button-bg)',
        borderRadius: 30,
        border: '1px solid var(--button-border)',
        padding: 18,
        width: 360,
        minWidth: 360,
        maxWidth: 360,
        flex: '0 0 360px',
        boxSizing: 'border-box',
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
      }}>
        <div style={{ width: '100%', minWidth: 0 }}>
          {isPng ? null : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, width: '100%', justifyContent: 'space-between', flexWrap: 'nowrap' }}>
                <div
                  ref={segmentedRef}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    background: 'var(--bg-color)',
                    borderRadius: 14,
                    boxSizing: 'border-box',
                    padding: 3,
                    gap: 2,
                    width: '100%',
                    flex: 1,
                    minWidth: 0,
                    position: 'relative',
                    border: 'none',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      position: 'absolute',
                      top: 3,
                      left: thumbStyle.left,
                      width: thumbStyle.width,
                      height: 'calc(100% - 6px)',
                      background: 'var(--segment-active-bg)',
                      borderRadius: 10,
                      zIndex: 0,
                      transition: 'left 0.25s cubic-bezier(.4,1.6,.6,1), width 0.25s cubic-bezier(.4,1.6,.6,1)',
                    }}
                  />
                  {MODES.map((m, i) => (
                    <button
                      key={m.value}
                      ref={el => { buttonRefs.current[i] = el; }}
                      type="button"
                      onClick={() => handleMode(m.value)}
                      style={{
                        flex: 1,
                        background: 'transparent',
                        color: mode === m.value ? 'var(--segment-active-text)' : 'var(--text-color)',
                        border: 'none',
                        borderRadius: 10,
                        padding: '5px 0',
                        fontWeight: 500,
                        cursor: 'pointer',
                        fontSize: 14,
                        minWidth: 0,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        position: 'relative',
                        zIndex: 1,
                        transition: 'color 0.2s',
                      }}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>
              {mode !== 'scale' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, width: '100%', flexWrap: 'nowrap' }}>
                  <select
                    className="preset-dropdown"
                    value={presets.find((p: any) => {
                      const matchNormal = Math.abs(p.width - width) < 0.05 && Math.abs(p.height - height) < 0.05;
                      const matchRotated = Math.abs(p.width - height) < 0.05 && Math.abs(p.height - width) < 0.05;
                      return matchNormal || matchRotated;
                    })?.name || 'presets'}
                    onChange={e => {
                      if (e.target.value === 'edit') {
                        onEditPresets();
                        return;
                      }
                      const preset = presets.find((p: any) => p.name === e.target.value);
                      if (preset) handlePreset(preset);
                    }}
                    style={{ padding: '2px 13px 2px 2px', borderRadius: 4, border: '1px solid var(--button-border)', height: 24, appearance: 'none', backgroundColor: 'transparent', color: 'var(--text-color)', fontSize: 14, fontWeight: 500, cursor: 'pointer', textAlign: 'left', width: 70, minWidth: 70, maxWidth: 70, flex: '0 0 70px', marginRight: 8 }}
                  >
                    <option value="presets">Presets</option>
                    {presets.map((p: any) => (
                      <option key={p.name} value={p.name}>{p.name}</option>
                    ))}
                    <option disabled>──────────</option>
                    <option value="edit">Edit...</option>
                  </select>
                  {(mode === 'fill' || isSingleAxisMode) && (
                    <>
                      {(mode === 'fitWidth' || mode === 'scale') ? (
                        <span style={{ textAlign: 'right', color: 'var(--secondary-color)', display: 'inline-block', fontSize: 14 }}>{formatValue(width)}</span>
                      ) : (
                        <input
                          type="text"
                          value={widthInput}
                          onChange={handleWidth}
                          onFocus={() => onFocus(adjuster.id)}
                          onBlur={() => { handleWidthBlur(); onBlur(); }}
                          onKeyDown={handleWidthKeyDown}
                          min={1}
                          style={{ width: 50, textAlign: 'right', borderRadius: 4, border: '1px solid var(--input-border)', fontSize: 14, padding: '2px 4px', display: 'inline-block', background: 'var(--input-bg)', color: 'var(--text-color)' }}
                        />
                      )}
                      {mode === 'fill' ? (
                        <button
                          type="button"
                          onClick={handleSwap}
                          style={{
                            margin: 0,
                            background: 'none',
                            border: 'none',
                            color: 'var(--text-color)',
                            cursor: 'pointer',
                            fontSize: 18,
                            display: 'flex',
                            alignItems: 'center',
                            width: 18,
                            minWidth: 18,
                            height: 18,
                            minHeight: 18,
                            padding: 0,
                          }}
                          title="Swap width and height"
                        >
                          {SwapIcon && <SwapIcon style={{ width: 16, height: 16, display: 'block', color: 'var(--text-color)' }} />}
                        </button>
                      ) : (
                        <span>×</span>
                      )}
                      {(mode === 'fitHeight' || mode === 'scale') ? (
                        <span style={{ textAlign: 'right', color: 'var(--secondary-color)', display: 'inline-block', fontSize: 14 }}>{formatValue(height)}</span>
                      ) : (
                        <input
                          type="text"
                          value={heightInput}
                          onChange={handleHeight}
                          onFocus={() => onFocus(adjuster.id)}
                          onBlur={() => { handleHeightBlur(); onBlur(); }}
                          onKeyDown={handleHeightKeyDown}
                          min={1}
                          style={{ width: 50, textAlign: 'right', borderRadius: 4, border: '1px solid var(--input-border)', fontSize: 14, padding: '2px 4px', display: 'inline-block', background: 'var(--input-bg)', color: 'var(--text-color)' }}
                        />
                      )}
                      <span>mm</span>
                    </>
                  )}
                </div>
              )}
            </>
          )}

          {isPng ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 28, width: '100%', flexWrap: 'nowrap' }}>
              <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-color)', minWidth: 36 }}>PNG:</span>
              <input
                type="text"
                value={widthInput}
                onChange={handleWidth}
                onFocus={() => onFocus(adjuster.id)}
                onBlur={() => { handleWidthBlur(); onBlur(); }}
                onKeyDown={handleWidthKeyDown}
                min={1}
                style={{ width: 50, textAlign: 'right', borderRadius: 4, border: '1px solid var(--input-border)', fontSize: 14, padding: '2px 4px', background: 'var(--input-bg)', color: 'var(--text-color)' }}
              />
              <span>×</span>
              <input
                type="text"
                value={heightInput}
                onChange={handleHeight}
                onFocus={() => onFocus(adjuster.id)}
                onBlur={() => { handleHeightBlur(); onBlur(); }}
                onKeyDown={handleHeightKeyDown}
                min={1}
                style={{ width: 50, textAlign: 'right', borderRadius: 4, border: '1px solid var(--input-border)', fontSize: 14, padding: '2px 4px', background: 'var(--input-bg)', color: 'var(--text-color)' }}
              />
              <span>px</span>
              <span style={{ marginLeft: 8 }}>ppi:</span>
              <input
                type="text"
                value={ppiInput}
                onChange={handlePpi}
                onFocus={() => onFocus(adjuster.id)}
                onBlur={() => { handlePpiBlur(); onBlur(); }}
                onKeyDown={handlePpiKeyDown}
                min={1}
                style={{ width: 36, textAlign: 'right', borderRadius: 4, border: '1px solid var(--input-border)', fontSize: 14, padding: '2px 4px', background: 'var(--input-bg)', color: 'var(--text-color)' }}
              />
            </div>
          ) : (
            <>
              {mode === 'scale' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 28, width: '100%', flexWrap: 'nowrap' }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      background: 'var(--bg-color)',
                      borderRadius: 8,
                      border: '1px solid var(--button-border)',
                      padding: 1,
                      width: 96,
                      height: 24,
                      boxSizing: 'border-box',
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => handleScaleUnit('factor')}
                      style={{
                        flex: 1,
                        minWidth: 54,
                        height: '100%',
                        border: 'none',
                        borderRadius: 6,
                        background: scaleUnit === 'factor' ? 'var(--segment-active-bg)' : 'transparent',
                        color: scaleUnit === 'factor' ? 'var(--segment-active-text)' : 'var(--text-color)',
                        fontSize: 12,
                        fontWeight: 500,
                        cursor: 'pointer',
                        padding: 0,
                      }}
                    >
                      Scale
                    </button>
                    <button
                      type="button"
                      onClick={() => handleScaleUnit('percent')}
                      style={{
                        flex: 1,
                        minWidth: 28,
                        height: '100%',
                        border: 'none',
                        borderRadius: 6,
                        background: scaleUnit === 'percent' ? 'var(--segment-active-bg)' : 'transparent',
                        color: scaleUnit === 'percent' ? 'var(--segment-active-text)' : 'var(--text-color)',
                        fontSize: 12,
                        fontWeight: 500,
                        cursor: 'pointer',
                        padding: 0,
                      }}
                    >
                      %
                    </button>
                  </div>
                  <input
                    type="text"
                    value={scaleInput}
                    onChange={handleScale}
                    onFocus={() => onFocus(adjuster.id)}
                    onBlur={() => { handleScaleBlur(); onBlur(); }}
                    onKeyDown={handleScaleKeyDown}
                    min={0.01}
                    style={{ width: 32, textAlign: 'right', borderRadius: 4, border: '1px solid var(--input-border)', fontSize: 14, padding: '2px 4px', background: 'var(--input-bg)', color: 'var(--text-color)' }}
                  />
                  <span style={{ color: 'var(--secondary-color)' }}>→</span>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap', color: 'var(--secondary-color)', fontSize: 14 }}>
                    <span style={{ textAlign: 'right' }}>{formatValue(width)}</span>
                    <span>×</span>
                    <span style={{ textAlign: 'right' }}>{formatValue(height)}</span>
                    <span style={{ marginLeft: 2 }}>mm</span>
                  </div>
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 28, width: '100%', flexWrap: 'nowrap', marginTop: 4 }}>
                <span style={{ minWidth: 56, fontSize: 14 }}>Padding:</span>
                <input
                  type="text"
                  value={marginInput}
                  onChange={handleMargin}
                  onFocus={() => onFocus(adjuster.id)}
                  onBlur={() => { handleMarginBlur(); onBlur(); }}
                  onKeyDown={handleMarginKeyDown}
                  min={0}
                  style={{ width: 20, textAlign: 'right', borderRadius: 4, border: '1px solid var(--input-border)', fontSize: 14, padding: '2px 4px', background: 'var(--input-bg)', color: 'var(--text-color)' }}
                />
                {marginMm > 0 && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      background: 'var(--bg-color)',
                      borderRadius: 8,
                      border: '1px solid var(--button-border)',
                      padding: 1,
                      width: 50,
                      height: 24,
                      boxSizing: 'border-box',
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => onChange({ ...adjuster, paddingMode: 'inside', source: 'manual' })}
                      style={{
                        flex: 1,
                        minWidth: 22,
                        height: '100%',
                        border: 'none',
                        borderRadius: 6,
                        background: paddingMode === 'inside' ? 'var(--segment-active-bg)' : 'transparent',
                        color: paddingMode === 'inside' ? 'var(--segment-active-text)' : 'var(--text-color)',
                        fontSize: 11,
                        fontWeight: 500,
                        cursor: 'pointer',
                        padding: 0,
                      }}
                    >
                      In
                    </button>
                    <button
                      type="button"
                      onClick={() => onChange({ ...adjuster, paddingMode: 'outside', source: 'manual' })}
                      style={{
                        flex: 1,
                        minWidth: 30,
                        height: '100%',
                        border: 'none',
                        borderRadius: 6,
                        background: paddingMode === 'outside' ? 'var(--segment-active-bg)' : 'transparent',
                        color: paddingMode === 'outside' ? 'var(--segment-active-text)' : 'var(--text-color)',
                        fontSize: 11,
                        fontWeight: 500,
                        cursor: 'pointer',
                        padding: 0,
                      }}
                    >
                      Out
                    </button>
                  </div>
                )}
                {marginMm > 0 && (
                  <>
                    <span style={{ color: 'var(--secondary-color)' }}>→</span>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap', color: 'var(--secondary-color)', fontSize: 14 }}>
                      <span style={{ textAlign: 'right' }}>
                        {formatValue(paddingMode === 'outside' ? outsideWidthMm : insideWidthMm)}
                      </span>
                      <span>×</span>
                      <span style={{ textAlign: 'right' }}>
                        {formatValue(paddingMode === 'outside' ? outsideHeightMm : insideHeightMm)}
                      </span>
                      <span style={{ marginLeft: 2 }}>mm</span>
                    </div>
                  </>
                )}
                {mode === 'scale' ? (
                  <span style={{ minWidth: 0 }} />
                ) : (
                  <span style={{ minWidth: 126 }} />
                )}
              </div>
            </>
          )}
        </div>
      </div>
      {isRemovable && (
        <button
          type="button"
          onClick={onRemove}
          style={{
            color: 'red',
            background: 'none',
            cursor: 'pointer',
            border: 'none',
            alignItems: 'center',
            justifyContent: 'center',
            width: 36,
            height: 36,
            minWidth: 36,
            minHeight: 36,
            flexShrink: 0,
            marginLeft: 10,
          }}
          title="Remove"
        >
          {RemoveIcon && <RemoveIcon style={{ width: 22, height: 22, display: 'block', color: 'red' }} />}
        </button>
      )}
    </div>
  );
}
