import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import './App.css'
import './sort-filter.css'
import { createEngine } from './engine/core.js'

const TOTAL_ROWS  = 50
const TOTAL_COLS  = 50
const STORAGE_KEY = 'spreadsheet_v2'
const SAVE_DELAY  = 500

function debounce(fn, ms) {
  let t
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms) }
}

function parseTSV(text) {
  return text
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd()
    .split('\n').map(row => row.split('\t'))
}

export default function App() {
  const [engine]       = useState(() => createEngine(TOTAL_ROWS, TOTAL_COLS))
  const [version,      setVersion]      = useState(0)
  const [selectedCell, setSelectedCell] = useState(null)
  const [editingCell,  setEditingCell]  = useState(null)
  const [editValue,    setEditValue]    = useState('')
  const [cellStyles,   setCellStyles]   = useState({})
  const [sortState,    setSortState]    = useState({ col: null, dir: null })
  const [filterState,  setFilterState]  = useState({})
  const [filterOpen,   setFilterOpen]   = useState(null)
  const [copySource,   setCopySource]   = useState(null)

  const cellInputRef    = useRef(null)
  const filterRef       = useRef(null)
  const clipboardTA     = useRef(null)
  // Ref mirror of selectedCell — always current inside async/event callbacks
  const selectedCellRef = useRef(null)

  const forceRerender = useCallback(() => setVersion(v => v + 1), [])

  // Keep ref in sync so toolbar callbacks always see latest selected cell
  useEffect(() => { selectedCellRef.current = selectedCell }, [selectedCell])

  // ── localStorage ──────────────────────────────
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const saved = JSON.parse(raw)
      if (saved.cells)  engine.importCells(saved.cells)
      if (saved.styles) setCellStyles(saved.styles)
      forceRerender()
    } catch (e) { console.warn('restore failed', e) }
  }, []) // eslint-disable-line

  const _save = useRef(debounce((eng, styles) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        rows: eng.rows, cols: eng.cols,
        cells: eng.exportCells(), styles,
      }))
    } catch (e) { console.warn('save failed', e) }
  }, SAVE_DELAY)).current

  useEffect(() => { _save(engine, cellStyles) }, [version, cellStyles]) // eslint-disable-line

  // ── Cell styles ───────────────────────────────
  const getCellStyle = useCallback((r, c) =>
    cellStyles[`${r},${c}`] || { bold: false, italic: false, underline: false, bg: 'white', color: '#202124', align: 'left', fontSize: 13 }
  , [cellStyles])

  const updateCellStyle = useCallback((r, c, updates) => {
    setCellStyles(prev => ({ ...prev, [`${r},${c}`]: { ...getCellStyle(r, c), ...updates } }))
  }, [getCellStyle])

  // ── Sort & Filter ─────────────────────────────
  const visibleRows = useMemo(() => {
    const indices = Array.from({ length: engine.rows }, (_, i) => i)
    const active  = Object.keys(filterState).map(Number)
    if (!active.length) return indices
    return indices.filter(r =>
      active.every(c => {
        const allowed = filterState[c]
        if (!allowed || !allowed.size) return true
        return allowed.has(String(engine.getCellComputed(r, c) ?? ''))
      })
    )
  }, [filterState, version, engine]) // eslint-disable-line

  const displayRows = useMemo(() => {
    if (sortState.col === null) return visibleRows
    return [...visibleRows].sort((a, b) => {
      const av = engine.getCellComputed(a, sortState.col)
      const bv = engine.getCellComputed(b, sortState.col)
      const an = Number(av), bn = Number(bv)
      const numA = !isNaN(an) && av !== '' ? an : null
      const numB = !isNaN(bn) && bv !== '' ? bn : null
      const cmp  = (numA !== null && numB !== null)
        ? numA - numB
        : String(av ?? '').localeCompare(String(bv ?? ''), undefined, { numeric: true })
      return sortState.dir === 'asc' ? cmp : -cmp
    })
  }, [visibleRows, sortState, version, engine]) // eslint-disable-line

  const cycleSort = useCallback((col) => {
    setSortState(prev => {
      if (prev.col !== col)    return { col, dir: 'asc' }
      if (prev.dir === 'asc')  return { col, dir: 'desc' }
      return { col: null, dir: null }
    })
    setFilterOpen(null)
  }, [])

  const getColumnValues = useCallback((col) => {
    const vals = new Set()
    for (let r = 0; r < engine.rows; r++)
      vals.add(String(engine.getCellComputed(r, col) ?? ''))
    return [...vals].sort((a, b) => {
      const na = Number(a), nb = Number(b)
      return (!isNaN(na) && !isNaN(nb)) ? na - nb : a.localeCompare(b, undefined, { numeric: true })
    })
  }, [version, engine]) // eslint-disable-line

  const toggleFilterValue = useCallback((col, val) => {
    setFilterState(prev => {
      const allVals = new Set(Array.from({ length: engine.rows }, (_, r) => String(engine.getCellComputed(r, col) ?? '')))
      const current = prev[col] ?? new Set(allVals)
      const next    = new Set(current)
      if (next.has(val)) next.delete(val); else next.add(val)
      if (next.size === allVals.size) { const { [col]: _, ...rest } = prev; return rest }
      return { ...prev, [col]: next }
    })
  }, [engine, version]) // eslint-disable-line

  const clearFilter = useCallback((col) => {
    setFilterState(prev => { const { [col]: _, ...rest } = prev; return rest })
  }, [])

  useEffect(() => {
    if (filterOpen === null) return
    const h = (e) => { if (filterRef.current && !filterRef.current.contains(e.target)) setFilterOpen(null) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [filterOpen])

  // ── Cell editing ──────────────────────────────
  const startEditing = useCallback((r, c) => {
    setSelectedCell({ r, c })
    setEditingCell({ r, c })
    setEditValue(engine.getCell(r, c).raw)
    setTimeout(() => cellInputRef.current?.focus(), 0)
  }, [engine])

  const commitEdit = useCallback((r, c) => {
    const current = engine.getCell(r, c)
    if (current.raw !== editValue) { engine.setCell(r, c, editValue); forceRerender() }
    setEditingCell(null)
  }, [engine, editValue, forceRerender])

  const handleCellClick = useCallback((r, c) => {
    if (editingCell && (editingCell.r !== r || editingCell.c !== c)) commitEdit(editingCell.r, editingCell.c)
    if (!editingCell || editingCell.r !== r || editingCell.c !== c) startEditing(r, c)
  }, [editingCell, commitEdit, startEditing])

  const handleKeyDown = useCallback((e, r, c) => {
    if (e.key === 'Enter')           { e.preventDefault(); commitEdit(r, c); startEditing(Math.min(r+1, engine.rows-1), c) }
    else if (e.key === 'Tab')        { e.preventDefault(); commitEdit(r, c); startEditing(r, Math.min(c+1, engine.cols-1)) }
    else if (e.key === 'Escape')     { setEditValue(engine.getCell(r, c).raw); setEditingCell(null) }
    else if (e.key === 'ArrowDown')  { e.preventDefault(); commitEdit(r, c); startEditing(Math.min(r+1, engine.rows-1), c) }
    else if (e.key === 'ArrowUp')    { e.preventDefault(); commitEdit(r, c); startEditing(Math.max(r-1, 0), c) }
    else if (e.key === 'ArrowLeft')  { e.preventDefault(); commitEdit(r, c); if (c > 0) startEditing(r, c-1); else if (r > 0) startEditing(r-1, engine.cols-1) }
    else if (e.key === 'ArrowRight') { e.preventDefault(); commitEdit(r, c); startEditing(r, Math.min(c+1, engine.cols-1)) }
  }, [engine, commitEdit, startEditing])

  // ── Copy / Paste ──────────────────────────────
  // Uses an off-screen <textarea> as the clipboard bridge.
  // execCommand('copy') works synchronously inside a user-gesture handler,
  // which is why we use toolbar button clicks (always trusted events).

  const doInternalCopy = useCallback(() => {
    const cell = selectedCellRef.current
    if (!cell) {
      alert('No cell selected — please click a cell first then click Copy')
      return
    }
    const val  = engine.getCellComputed(cell.r, cell.c)
    const text = val != null ? String(val) : ''
    const ta   = clipboardTA.current
    if (!ta) return
    ta.value = text
    ta.focus()
    ta.select()
    document.execCommand('copy')
    setCopySource({ r: cell.r, c: cell.c })
    setTimeout(() => cellInputRef.current?.focus(), 50)
  }, [engine])

  const doInternalPaste = useCallback(() => {
    const cell = selectedCellRef.current
    if (!cell) return
    const ta = clipboardTA.current
    if (!ta) return
    ta.value = ''
    ta.focus()
    document.execCommand('paste')
  }, [])

  const handleTAPaste = useCallback((e) => {
    e.preventDefault()
    const cell = selectedCellRef.current
    if (!cell) return
    const text = e.clipboardData.getData('text/plain')
    if (!text) return
    const parsed  = parseTSV(text)
    const changes = []
    for (let dr = 0; dr < parsed.length; dr++) {
      for (let dc = 0; dc < parsed[dr].length; dc++) {
        const tr = cell.r + dr
        const tc = cell.c + dc
        if (tr < engine.rows && tc < engine.cols)
          changes.push({ r: tr, c: tc, raw: parsed[dr][dc] })
      }
    }
    if (changes.length) { engine.setCells(changes); forceRerender() }
    setTimeout(() => cellInputRef.current?.focus(), 50)
  }, [engine, forceRerender])

  // Ctrl+Z / Ctrl+Y global — works from anywhere on the page
  useEffect(() => {
    const h = (e) => {
      const ctrl = e.ctrlKey || e.metaKey
      if (ctrl && e.key === 'z') { e.preventDefault(); if (engine.undo()) forceRerender() }
      if (ctrl && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { e.preventDefault(); if (engine.redo()) forceRerender() }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [engine, forceRerender])

  // ── Formula bar ───────────────────────────────
  const handleFormulaBarChange  = useCallback((val) => { if (!editingCell && selectedCell) setEditingCell(selectedCell); setEditValue(val) }, [editingCell, selectedCell])
  const handleFormulaBarFocus   = useCallback(() => { if (selectedCell && !editingCell) { setEditingCell(selectedCell); setEditValue(engine.getCell(selectedCell.r, selectedCell.c).raw) } }, [selectedCell, editingCell, engine])
  const handleFormulaBarKeyDown = useCallback((e) => { if (!editingCell) return; handleKeyDown(e, editingCell.r, editingCell.c) }, [editingCell, handleKeyDown])

  // ── Toolbar ───────────────────────────────────
  const handleUndo      = useCallback(() => { if (engine.undo()) forceRerender() }, [engine, forceRerender])
  const handleRedo      = useCallback(() => { if (engine.redo()) forceRerender() }, [engine, forceRerender])
  const toggleBold      = useCallback(() => { if (!selectedCell) return; const s = getCellStyle(selectedCell.r, selectedCell.c); updateCellStyle(selectedCell.r, selectedCell.c, { bold:      !s.bold      }) }, [selectedCell, getCellStyle, updateCellStyle])
  const toggleItalic    = useCallback(() => { if (!selectedCell) return; const s = getCellStyle(selectedCell.r, selectedCell.c); updateCellStyle(selectedCell.r, selectedCell.c, { italic:    !s.italic    }) }, [selectedCell, getCellStyle, updateCellStyle])
  const toggleUnderline = useCallback(() => { if (!selectedCell) return; const s = getCellStyle(selectedCell.r, selectedCell.c); updateCellStyle(selectedCell.r, selectedCell.c, { underline: !s.underline }) }, [selectedCell, getCellStyle, updateCellStyle])
  const changeFontSize  = useCallback((size)  => { if (!selectedCell) return; updateCellStyle(selectedCell.r, selectedCell.c, { fontSize: size }) }, [selectedCell, updateCellStyle])
  const changeAlignment = useCallback((align) => { if (!selectedCell) return; updateCellStyle(selectedCell.r, selectedCell.c, { align }) }, [selectedCell, updateCellStyle])
  const changeFontColor = useCallback((color) => { if (!selectedCell) return; updateCellStyle(selectedCell.r, selectedCell.c, { color }) }, [selectedCell, updateCellStyle])
  const changeBgColor   = useCallback((bg)    => { if (!selectedCell) return; updateCellStyle(selectedCell.r, selectedCell.c, { bg }) }, [selectedCell, updateCellStyle])

  const clearCell = useCallback(() => {
    if (!selectedCell) return
    engine.setCell(selectedCell.r, selectedCell.c, '')
    forceRerender()
    setCellStyles(prev => { const n = { ...prev }; delete n[`${selectedCell.r},${selectedCell.c}`]; return n })
    setEditValue('')
  }, [selectedCell, engine, forceRerender])

  const clearAll = useCallback(() => {
    for (let r = 0; r < engine.rows; r++) for (let c = 0; c < engine.cols; c++) engine.setCell(r, c, '')
    forceRerender(); setCellStyles({}); setSortState({ col: null, dir: null }); setFilterState({})
    setSelectedCell(null); setEditingCell(null); setEditValue('')
    localStorage.removeItem(STORAGE_KEY)
  }, [engine, forceRerender])

  const insertRow    = useCallback(() => { if (!selectedCell) return; engine.insertRow(selectedCell.r);    forceRerender(); setSelectedCell({ r: selectedCell.r+1, c: selectedCell.c }) }, [selectedCell, engine, forceRerender])
  const deleteRow    = useCallback(() => { if (!selectedCell) return; engine.deleteRow(selectedCell.r);    forceRerender(); if (selectedCell.r >= engine.rows) setSelectedCell({ r: engine.rows-1, c: selectedCell.c }) }, [selectedCell, engine, forceRerender])
  const insertColumn = useCallback(() => { if (!selectedCell) return; engine.insertColumn(selectedCell.c); forceRerender(); setSelectedCell({ r: selectedCell.r, c: selectedCell.c+1 }) }, [selectedCell, engine, forceRerender])
  const deleteColumn = useCallback(() => { if (!selectedCell) return; engine.deleteColumn(selectedCell.c); forceRerender(); if (selectedCell.c >= engine.cols) setSelectedCell({ r: selectedCell.r, c: engine.cols-1 }) }, [selectedCell, engine, forceRerender])

  // ── Derived ───────────────────────────────────
  const selectedCellStyle = useMemo(() => selectedCell ? getCellStyle(selectedCell.r, selectedCell.c) : null, [selectedCell, getCellStyle])
  const colLabel = useCallback((c) => engine.colLabel(c), [engine])
  const selectedCellLabel = selectedCell ? `${colLabel(selectedCell.c)}${selectedCell.r+1}` : 'No cell'
  const formulaBarValue   = editingCell ? editValue : (selectedCell ? engine.getCell(selectedCell.r, selectedCell.c).raw : '')
  const sortIcon = (col)  => sortState.col === col ? (sortState.dir === 'asc' ? '↑' : '↓') : '⇅'
  const hasFilter = (col) => !!filterState[col]

  // ── Render ────────────────────────────────────
  return (
    <div className="app-wrapper">

      {/* Off-screen textarea — clipboard bridge for copy/paste */}
      <textarea
        ref={clipboardTA}
        onPaste={handleTAPaste}
        style={{ position: 'fixed', top: '-9999px', left: '-9999px', width: '1px', height: '1px', opacity: 0, pointerEvents: 'none' }}
        tabIndex={-1}
      />

      <div className="app-header">
        <h2 className="app-title">📊 Spreadsheet App</h2>
      </div>

      <div className="main-content">
        {/* ── Toolbar ── */}
        <div className="toolbar">
          <div className="toolbar-group">
            <button className={`toolbar-btn bold-btn ${selectedCellStyle?.bold ? 'active' : ''}`}           onClick={toggleBold}      title="Bold">B</button>
            <button className={`toolbar-btn italic-btn ${selectedCellStyle?.italic ? 'active' : ''}`}       onClick={toggleItalic}    title="Italic">I</button>
            <button className={`toolbar-btn underline-btn ${selectedCellStyle?.underline ? 'active' : ''}`} onClick={toggleUnderline} title="Underline">U</button>
          </div>
          <div className="toolbar-group">
            <span className="toolbar-label">Size:</span>
            <select className="toolbar-select" value={selectedCellStyle?.fontSize || 13} onChange={(e) => changeFontSize(parseInt(e.target.value))}>
              {[8,10,11,12,13,14,16,18,20,24].map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="toolbar-group">
            <button className={`align-btn ${selectedCellStyle?.align === 'left'   ? 'active' : ''}`} onClick={() => changeAlignment('left')}   title="Left">⬤←</button>
            <button className={`align-btn ${selectedCellStyle?.align === 'center' ? 'active' : ''}`} onClick={() => changeAlignment('center')} title="Center">⬤</button>
            <button className={`align-btn ${selectedCellStyle?.align === 'right'  ? 'active' : ''}`} onClick={() => changeAlignment('right')}  title="Right">⬤→</button>
          </div>
          <div className="toolbar-group">
            <span className="toolbar-label">Text:</span>
            <input type="color" value={selectedCellStyle?.color || '#202124'} onChange={(e) => changeFontColor(e.target.value)} className="color-picker" />
          </div>
          <div className="toolbar-group">
            <span className="toolbar-label">Fill:</span>
            <select className="toolbar-select" value={selectedCellStyle?.bg || 'white'} onChange={(e) => changeBgColor(e.target.value)}>
              <option value="white">White</option>
              <option value="#ffff99">Yellow</option>
              <option value="#99ffcc">Green</option>
              <option value="#ffcccc">Red</option>
              <option value="#cce5ff">Blue</option>
              <option value="#e0ccff">Purple</option>
              <option value="#ffd9b3">Orange</option>
              <option value="#f0f0f0">Gray</option>
            </select>
          </div>
          <div className="toolbar-group">
            <button className="toolbar-btn" onClick={handleUndo} disabled={!engine.canUndo()} title="Undo (Ctrl+Z)">↶ Undo</button>
            <button className="toolbar-btn" onClick={handleRedo} disabled={!engine.canRedo()} title="Redo (Ctrl+Y)">↷ Redo</button>
          </div>
          <div className="toolbar-group">
            <button className="toolbar-btn copy-btn" onClick={doInternalCopy} title="Copy cell value">⎘ Copy</button>
            <button className="toolbar-btn paste-btn" onClick={doInternalPaste} title="Paste here">⎙ Paste</button>
          </div>
          <div className="toolbar-group">
            <button className="toolbar-btn" onClick={insertRow}    title="Insert Row above">+ Row</button>
            <button className="toolbar-btn" onClick={deleteRow}    title="Delete Row">− Row</button>
            <button className="toolbar-btn" onClick={insertColumn} title="Insert Col left">+ Col</button>
            <button className="toolbar-btn" onClick={deleteColumn} title="Delete Col">− Col</button>
          </div>
          <div className="toolbar-group">
            <button className="toolbar-btn danger" onClick={clearCell}>✕ Cell</button>
            <button className="toolbar-btn danger" onClick={clearAll}>✕ All</button>
          </div>
        </div>

        {/* ── Formula Bar ── */}
        <div className="formula-bar">
          <span className="formula-bar-label">{selectedCellLabel}</span>
          <input
            className="formula-bar-input"
            value={formulaBarValue}
            onChange={(e) => handleFormulaBarChange(e.target.value)}
            onKeyDown={handleFormulaBarKeyDown}
            onFocus={handleFormulaBarFocus}
            placeholder="Select a cell · =SUM(A1:A5) · =AVG(B1:B10) · =MAX(C1:C5)"
          />
        </div>

        {/* ── Grid ── */}
        <div className="grid-scroll">
          <table className="grid-table">
            <thead>
              <tr>
                <th className="col-header-blank"></th>
                {Array.from({ length: engine.cols }, (_, c) => (
                  <th key={c} className={`col-header ${sortState.col === c ? 'sorted' : ''} ${hasFilter(c) ? 'filtered' : ''}`}>
                    <div className="col-header-inner">
                      <span className="col-label" onClick={() => cycleSort(c)} title="Click to sort">
                        {colLabel(c)}<span className="sort-icon">{sortIcon(c)}</span>
                      </span>
                      <button
                        className={`filter-btn ${hasFilter(c) ? 'active' : ''}`}
                        onClick={(e) => { e.stopPropagation(); setFilterOpen(f => f === c ? null : c) }}
                        title="Filter"
                      >▾</button>
                    </div>
                    {filterOpen === c && (
                      <div className="filter-dropdown" ref={filterRef} onClick={(e) => e.stopPropagation()}>
                        <div className="filter-header">
                          <span>Filter: {colLabel(c)}</span>
                          <button className="filter-clear-btn" onClick={() => { clearFilter(c); setFilterOpen(null) }}>Clear</button>
                        </div>
                        <div className="filter-list">
                          {getColumnValues(c).map(val => (
                            <label key={val} className="filter-item">
                              <input
                                type="checkbox"
                                checked={!filterState[c] || filterState[c].has(val)}
                                onChange={() => toggleFilterValue(c, val)}
                              />
                              <span>{val === '' ? '(empty)' : val}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayRows.map((realRow) => (
                <tr key={realRow}>
                  <td className="row-header">{realRow + 1}</td>
                  {Array.from({ length: engine.cols }, (_, c) => {
                    const isSelected = selectedCell?.r === realRow && selectedCell?.c === c
                    const isEditing  = editingCell?.r  === realRow && editingCell?.c  === c
                    const isCopied   = copySource?.r   === realRow && copySource?.c   === c
                    const cell    = engine.getCell(realRow, c)
                    const style   = cellStyles[`${realRow},${c}`] || {}
                    const display = cell.error ? cell.error
                      : (cell.computed !== null && cell.computed !== '' ? String(cell.computed) : cell.raw)
                    return (
                      <td
                        key={c}
                        className={['cell', isSelected ? 'selected' : '', isCopied ? 'copied' : ''].join(' ').trim()}
                        style={{ background: style.bg || 'white' }}
                        onMouseDown={(e) => { e.preventDefault(); handleCellClick(realRow, c) }}
                      >
                        {isEditing ? (
                          <input
                            autoFocus
                            className="cell-input"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={() => commitEdit(realRow, c)}
                            onKeyDown={(e) => handleKeyDown(e, realRow, c)}
                            ref={isSelected ? cellInputRef : undefined}
                            style={{
                              fontWeight:     style.bold      ? 'bold'      : 'normal',
                              fontStyle:      style.italic    ? 'italic'    : 'normal',
                              textDecoration: style.underline ? 'underline' : 'none',
                              color:          style.color     || '#202124',
                              fontSize:       (style.fontSize || 13) + 'px',
                              textAlign:      style.align     || 'left',
                              background:     style.bg        || 'white',
                            }}
                          />
                        ) : (
                          <div
                            className={`cell-display align-${style.align || 'left'} ${cell.error ? 'error' : ''}`}
                            style={{
                              fontWeight:     style.bold      ? 'bold'      : 'normal',
                              fontStyle:      style.italic    ? 'italic'    : 'normal',
                              textDecoration: style.underline ? 'underline' : 'none',
                              color:          cell.error      ? '#d93025'   : (style.color || '#202124'),
                              fontSize:       (style.fontSize || 13) + 'px',
                            }}
                          >
                            {display}
                          </div>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="footer-hint">
          Click to select · Enter/Tab/Arrows navigate · <strong>⎘ Copy</strong> and <strong>⎙ Paste</strong> buttons in toolbar ·
          Ctrl+Z undo · Ctrl+Y redo · Click column letter to sort · ▾ to filter
        </p>
      </div>
    </div>
  )
}
