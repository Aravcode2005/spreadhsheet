

export function createEngine(initialRows, initialCols) {
 
  let grid = _makeGrid(initialRows, initialCols)
  let rows = initialRows
  let cols = initialCols

  const MAX_HISTORY = 100
  let history = []          
  let future  = []        

  function _snapshot() {
    history.push(_cloneGrid(grid, rows, cols))
    if (history.length > MAX_HISTORY) history.shift()
    future = []       
  }

  function _makeGrid(r, c) {
    return Array.from({ length: r }, () =>
      Array.from({ length: c }, () => ({ raw: '', computed: '', error: null }))
    )
  }

  function _cloneGrid(g, r, c) {
    return Array.from({ length: r }, (_, ri) =>
      Array.from({ length: c }, (_, ci) => ({ ...g[ri][ci] }))
    )
  }

  function _colLabel(c) {
    let label = ''
    let n = c + 1
    while (n > 0) {
      n--
      label = String.fromCharCode(65 + (n % 26)) + label
      n = Math.floor(n / 26)
    }
    return label
  }

  function _cellRef(label) {
   
    const m = label.toUpperCase().match(/^([A-Z]+)(\d+)$/)
    if (!m) return null
    let col = 0
    for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64)
    col--
    const row = parseInt(m[2], 10) - 1
    if (row < 0 || row >= rows || col < 0 || col >= cols) return null
    return { row, col }
  }

  // ── Formula evaluator ───────────────────────
  function _evaluate(raw, visitedSet = new Set()) {
    if (typeof raw !== 'string' || !raw.startsWith('=')) {
      const n = Number(raw)
      return { computed: isNaN(n) || raw === '' ? raw : n, error: null }
    }

    const expr = raw.slice(1).trim()

    const rangeFnMatch = expr.match(
      /^(SUM|AVG|AVERAGE|MAX|MIN|COUNT)\(([A-Z]+\d+):([A-Z]+\d+)\)$/i
    )
    if (rangeFnMatch) {
      const fn   = rangeFnMatch[1].toUpperCase()
      const from = _cellRef(rangeFnMatch[2])
      const to   = _cellRef(rangeFnMatch[3])
      if (!from || !to) return { computed: null, error: '#REF!' }

      const values = []
      for (let r = Math.min(from.row, to.row); r <= Math.max(from.row, to.row); r++) {
        for (let c = Math.min(from.col, to.col); c <= Math.max(from.col, to.col); c++) {
          const key = `${r},${c}`
          if (visitedSet.has(key)) return { computed: null, error: '#CIRC!' }
          const cell = grid[r]?.[c]
          if (!cell) continue
          const res = _evaluate(cell.raw, new Set([...visitedSet, key]))
          if (res.error) return { computed: null, error: res.error }
          const n = Number(res.computed)
          if (!isNaN(n)) values.push(n)
        }
      }
      if (values.length === 0) return { computed: 0, error: null }
      let result
      switch (fn) {
        case 'SUM':                         result = values.reduce((a, b) => a + b, 0); break
        case 'AVG': case 'AVERAGE':         result = values.reduce((a, b) => a + b, 0) / values.length; break
        case 'MAX':                         result = Math.max(...values); break
        case 'MIN':                         result = Math.min(...values); break
        case 'COUNT':                       result = values.length; break
        default:                            result = 0
      }
      return { computed: result, error: null }
    }

   
    let jsExpr = expr.replace(/\b([A-Z]+\d+)\b/gi, (match) => {
      const ref = _cellRef(match)
      if (!ref) return 'undefined'
      const key = `${ref.row},${ref.col}`
      if (visitedSet.has(key)) return 'undefined'  // circular → NaN path
      const cell = grid[ref.row]?.[ref.col]
      if (!cell) return '0'
      const res = _evaluate(cell.raw, new Set([...visitedSet, key]))
      if (res.error) return 'undefined'
      return res.computed !== '' && res.computed !== null ? res.computed : '0'
    })

    try {
     
      const result = Function('"use strict"; return (' + jsExpr + ')')()
      if (result === undefined || result === null) return { computed: '', error: null }
      if (typeof result === 'number' && !isFinite(result)) return { computed: null, error: '#DIV/0!' }
      return { computed: result, error: null }
    } catch {
      return { computed: null, error: '#ERR!' }
    }
  }

  function _recomputeAll() {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = grid[r][c]
        const res  = _evaluate(cell.raw)
        cell.computed = res.computed
        cell.error    = res.error
      }
    }
  }

  return {
    get rows() { return rows },
    get cols() { return cols },

    getCell(r, c) {
      if (r < 0 || r >= rows || c < 0 || c >= cols) return { raw: '', computed: '', error: null }
      return grid[r][c]
    },

   
    getCellComputed(r, c) {
      if (r < 0 || r >= rows || c < 0 || c >= cols) return ''
      const cell = grid[r][c]
      return cell.error ? cell.error : (cell.computed !== null && cell.computed !== '' ? cell.computed : cell.raw)
    },

    setCell(r, c, raw) {
      if (r < 0 || r >= rows || c < 0 || c >= cols) return
      _snapshot()
      grid[r][c].raw = raw ?? ''
      _recomputeAll()
    },


    setCells(changes) {
     
      _snapshot()
      for (const { r, c, raw } of changes) {
        if (r >= 0 && r < rows && c >= 0 && c < cols) {
          grid[r][c].raw = raw ?? ''
        }
      }
      _recomputeAll()
    },

   
    insertRow(atRow) {
      _snapshot()
      const newRow = Array.from({ length: cols }, () => ({ raw: '', computed: '', error: null }))
      grid.splice(atRow, 0, newRow)
      rows++
      _recomputeAll()
    },

    deleteRow(atRow) {
      if (rows <= 1) return
      _snapshot()
      grid.splice(atRow, 1)
      rows--
      _recomputeAll()
    },

    insertColumn(atCol) {
      _snapshot()
      for (let r = 0; r < rows; r++) {
        grid[r].splice(atCol, 0, { raw: '', computed: '', error: null })
      }
      cols++
      _recomputeAll()
    },

    deleteColumn(atCol) {
      if (cols <= 1) return
      _snapshot()
      for (let r = 0; r < rows; r++) {
        grid[r].splice(atCol, 1)
      }
      cols--
      _recomputeAll()
    },

   
    undo() {
      if (history.length === 0) return false
      future.push(_cloneGrid(grid, rows, cols))
      const prev = history.pop()
      grid = prev
      rows = prev.length
      cols = prev[0]?.length ?? cols
      _recomputeAll()
      return true
    },

    redo() {
      if (future.length === 0) return false
      history.push(_cloneGrid(grid, rows, cols))
      const next = future.pop()
      grid = next
      rows = next.length
      cols = next[0]?.length ?? cols
      _recomputeAll()
      return true
    },

    canUndo() { return history.length > 0 },
    canRedo() { return future.length > 0 },

  
    exportCells() {
      const out = {}
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const raw = grid[r][c].raw
          if (raw !== '' && raw != null) out[`${r},${c}`] = { raw }
        }
      }
      return out
    },

    importCells(cells) {
      
      for (const [key, val] of Object.entries(cells)) {
        const [r, c] = key.split(',').map(Number)
        if (!isNaN(r) && !isNaN(c) && r >= 0 && r < rows && c >= 0 && c < cols) {
          grid[r][c].raw = val.raw ?? ''
        }
      }
      _recomputeAll()
    },

    // Column label utility (exposed so App doesn't duplicate it)
    colLabel: _colLabel,
  }
}
