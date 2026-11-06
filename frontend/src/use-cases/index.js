// Use-case registry — the product catalog.
//
// A "use-case" is a sellable vertical: a set of modules from src/modules/ wired
// with vertical-specific parameters. Add a new vertical by dropping a folder
// here (e.g. ./warehouse) and registering it below — no module code changes.
//
// Consume it in a module page like:
//   import { moduleParams } from '@/use-cases'
//   const p = moduleParams(activeUseCase, 'employee-productivity')
//   // p.businessHours, p.breakGapSec, p.phone.holdSec, ...

import corporate from './corporate'
import retail from './retail'
import campus from './campus'
import school from './school'
import hostel from './hostel'
import hospitality from './hospitality'
import bank from './bank'

export const USE_CASES = { corporate, retail, campus, school, hostel, hospitality, bank }
export const DEFAULT_USE_CASE = 'corporate'

export function getUseCase(key) {
  return USE_CASES[key] || USE_CASES[DEFAULT_USE_CASE]
}

// Parameters for one module under one use-case (empty object if the use-case
// doesn't run that module).
export function moduleParams(useCaseKey, moduleKey) {
  return getUseCase(useCaseKey).params?.[moduleKey] || {}
}

// Does a use-case include a given module?
export function hasModule(useCaseKey, moduleKey) {
  return getUseCase(useCaseKey).modules.includes(moduleKey)
}
