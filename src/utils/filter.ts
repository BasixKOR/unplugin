import type { Hook, HookFilter, StringFilter, StringOrRegExp } from '../types'
import { resolve } from 'node:path'
import picomatch from 'picomatch'
import { toArray } from './general'

const BACKSLASH_REGEX = /\\/g
function normalize(path: string): string {
  return path.replace(BACKSLASH_REGEX, '/')
}

const ABSOLUTE_PATH_REGEX = /^(?:\/|(?:[A-Z]:)?[/\\|])/i
function isAbsolute(path: string): boolean {
  return ABSOLUTE_PATH_REGEX.test(path)
}

export type PluginFilter = (input: string) => boolean
export type TransformHookFilter = (id: string, code: string) => boolean

interface NormalizedStringFilter {
  include?: StringOrRegExp[]
  exclude?: StringOrRegExp[]
}

function getMatcherString(glob: string, cwd: string) {
  if (glob.startsWith('**') || isAbsolute(glob)) {
    return normalize(glob)
  }

  const resolved = resolve(cwd, glob)
  return normalize(resolved)
}

function patternToIdFilter(pattern: StringOrRegExp): PluginFilter {
  if (pattern instanceof RegExp) {
    return (id: string) => {
      const normalizedId = normalize(id)
      const result = pattern.test(normalizedId)
      pattern.lastIndex = 0
      return result
    }
  }
  const cwd = process.cwd()
  const glob = getMatcherString(pattern, cwd)
  const matcher = picomatch(glob, { dot: true })
  return (id: string) => {
    const normalizedId = normalize(id)
    return matcher(normalizedId)
  }
}

function patternToCodeFilter(pattern: StringOrRegExp): PluginFilter {
  if (pattern instanceof RegExp) {
    return (code: string) => {
      const result = pattern.test(code)
      pattern.lastIndex = 0
      return result
    }
  }
  return (code: string) => code.includes(pattern)
}

function createFilter(
  exclude: PluginFilter[] | undefined,
  include: PluginFilter[] | undefined,
): PluginFilter | undefined {
  if (!exclude && !include) {
    return
  }

  return (input) => {
    if (exclude?.some(filter => filter(input))) {
      return false
    }
    if (include?.some(filter => filter(input))) {
      return true
    }
    return !(include && include.length > 0)
  }
}

function normalizeFilter(filter: StringFilter): NormalizedStringFilter {
  if (typeof filter === 'string' || filter instanceof RegExp) {
    return {
      include: [filter],
    }
  }
  if (Array.isArray(filter)) {
    return {
      include: filter,
    }
  }
  return {
    exclude: filter.exclude ? toArray(filter.exclude) : undefined,
    include: filter.include ? toArray(filter.include) : undefined,
  }
}

function createIdFilter(filter: StringFilter | undefined): PluginFilter | undefined {
  if (!filter)
    return
  const { exclude, include } = normalizeFilter(filter)
  const excludeFilter = exclude?.map(patternToIdFilter)
  const includeFilter = include?.map(patternToIdFilter)
  return createFilter(excludeFilter, includeFilter)
}

function createCodeFilter(filter: StringFilter | undefined): PluginFilter | undefined {
  if (!filter)
    return
  const { exclude, include } = normalizeFilter(filter)
  const excludeFilter = exclude?.map(patternToCodeFilter)
  const includeFilter = include?.map(patternToCodeFilter)
  return createFilter(excludeFilter, includeFilter)
}

function createFilterForId(filter: StringFilter | undefined): PluginFilter | undefined {
  const filterFunction = createIdFilter(filter)
  return filterFunction ? id => !!filterFunction(id) : undefined
}

function createFilterForTransform(
  idFilter: StringFilter | undefined,
  codeFilter: StringFilter | undefined,
): TransformHookFilter | undefined {
  if (!idFilter && !codeFilter)
    return
  const idFilterFunction = createIdFilter(idFilter)
  const codeFilterFunction = createCodeFilter(codeFilter)
  return (id, code) => {
    let fallback = true
    if (idFilterFunction) {
      fallback &&= idFilterFunction(id)
    }
    if (!fallback) {
      return false
    }

    if (codeFilterFunction) {
      fallback &&= codeFilterFunction(code)
    }
    return fallback
  }
}

export function normalizeObjectHook<T extends (...args: any[]) => any, F extends keyof HookFilter>(
  name: 'resolveId' | 'load',
  hook: Hook<T, F>,
): { handler: T, filter: PluginFilter }
export function normalizeObjectHook<T extends (...args: any[]) => any, F extends keyof HookFilter>(
  name: 'transform',
  hook: Hook<T, F>,
): { handler: T, filter: TransformHookFilter }
export function normalizeObjectHook<T extends (...args: any[]) => any, F extends keyof HookFilter>(
  name: 'resolveId' | 'load' | 'transform',
  hook: Hook<T, F>,
): {
  handler: T
  filter: PluginFilter | TransformHookFilter
} {
  let handler: T
  let filter: PluginFilter | TransformHookFilter | undefined

  if (typeof hook === 'function') {
    handler = hook
  }
  else {
    handler = hook.handler
    const hookFilter = hook.filter as HookFilter | undefined
    if (name === 'resolveId' || name === 'load') {
      filter = createFilterForId(hookFilter?.id)
    }
    else {
      filter = createFilterForTransform(hookFilter?.id, hookFilter?.code)
    }
  }

  return {
    handler,
    filter: filter || (() => true),
  }
}
