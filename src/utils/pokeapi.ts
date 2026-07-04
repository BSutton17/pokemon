// Loads a Pokémon from PokeAPI with its Gen IV (Platinum) level-up moveset and
// stats scaled to a given level.
import {
  type LearnsetEntry,
  type Move,
  type MoveCategory,
  type Pokemon,
  type SlotKind,
  type Stats,
} from '../data/pokemonData'

const API = 'https://pokeapi.co/api/v2'

// Preference order for reading level-up learnsets: Platinum first, then the
// other Gen IV games as a fallback for Pokémon not present in Platinum.
const GEN4_VERSION_GROUPS = ['platinum', 'diamond-pearl', 'heartgold-soulsilver']

// Estimated spread for in-game Pokémon: average IVs, no EVs, neutral nature.
// We can't know exact spreads, so this keeps stat estimates reasonable.
const ASSUMED_IV = 15

function cap(value: string): string {
  return value
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

// Turn user input into an API-style slug: "Mr. Mime" -> "mr-mime".
export function normalizeQuery(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s.']+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

// Standard Levenshtein edit distance, used to tolerate small spelling slips.
function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  let curr = new Array<number>(b.length + 1)
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[b.length]
}

// The full list of Pokémon names (slugs), fetched once and reused for search.
export async function fetchPokemonNames(): Promise<string[]> {
  const res = await fetch(`${API}/pokemon?limit=100000`)
  if (!res.ok) throw new Error('Could not load the Pokédex index.')
  const data = (await res.json()) as { results: { name: string }[] }
  return data.results.map((entry) => entry.name)
}

// Live suggestions for a partially/incorrectly typed name: prefix matches
// first, then substring matches, then close typos by edit distance.
export function suggestNames(query: string, names: string[], limit = 6): string[] {
  const clean = normalizeQuery(query)
  if (!clean || names.length === 0) return []

  const starts: string[] = []
  const contains: string[] = []
  for (const name of names) {
    if (name === clean) continue
    if (name.startsWith(clean)) starts.push(name)
    else if (name.includes(clean)) contains.push(name)
  }

  const results = [...starts.slice(0, limit)]
  if (results.length < limit) results.push(...contains.slice(0, limit - results.length))

  if (results.length < limit && clean.length >= 3) {
    const seen = new Set(results)
    const fuzzy = names
      .filter((name) => !seen.has(name) && Math.abs(name.length - clean.length) <= 3)
      .map((name) => ({ name, distance: levenshtein(clean, name) }))
      .filter((entry) => entry.distance <= 2)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit - results.length)
      .map((entry) => entry.name)
    results.push(...fuzzy)
  }

  return results
}

export interface NameResolution {
  name: string // best-guess slug to fetch
  corrected: boolean // true if we changed the user's spelling
  matched: boolean // true if we're confident it's a real Pokémon
  suggestions: string[]
}

// Resolve a typed name to the closest real Pokémon, tolerating small typos.
export function resolvePokemonName(query: string, names: string[]): NameResolution {
  const clean = normalizeQuery(query)
  if (names.length === 0) {
    // Index not loaded yet — fall back to a direct lookup.
    return { name: clean, corrected: false, matched: Boolean(clean), suggestions: [] }
  }
  if (names.includes(clean)) {
    return { name: clean, corrected: false, matched: true, suggestions: [] }
  }

  const suggestions = suggestNames(clean, names)
  const threshold = clean.length <= 4 ? 1 : clean.length <= 7 ? 2 : 3
  const closest = suggestions
    .map((name) => ({ name, distance: levenshtein(clean, name) }))
    .sort((a, b) => a.distance - b.distance)[0]

  if (closest && closest.distance <= threshold) {
    return { name: closest.name, corrected: true, matched: true, suggestions }
  }
  return { name: clean, corrected: false, matched: false, suggestions }
}

function statAtLevel(base: number, level: number, isHp: boolean): number {
  const core = Math.floor(((2 * base + ASSUMED_IV) * level) / 100)
  return isHp ? core + level + 10 : core + 5
}

function computeStats(base: Stats, level: number): Stats {
  return {
    hp: statAtLevel(base.hp, level, true),
    attack: statAtLevel(base.attack, level, false),
    defense: statAtLevel(base.defense, level, false),
    spAttack: statAtLevel(base.spAttack, level, false),
    spDefense: statAtLevel(base.spDefense, level, false),
    speed: statAtLevel(base.speed, level, false),
  }
}

interface RawMoveRef {
  move: { name: string; url: string }
  version_group_details: {
    level_learned_at: number
    move_learn_method: { name: string }
    version_group: { name: string }
  }[]
}

interface RawStat {
  base_stat: number
  stat: { name: string }
}

function mapBaseStats(stats: RawStat[]): Stats {
  const lookup: Record<string, number> = {}
  for (const entry of stats) lookup[entry.stat.name] = entry.base_stat
  return {
    hp: lookup.hp ?? 50,
    attack: lookup.attack ?? 50,
    defense: lookup.defense ?? 50,
    spAttack: lookup['special-attack'] ?? 50,
    spDefense: lookup['special-defense'] ?? 50,
    speed: lookup.speed ?? 50,
  }
}

// Pick the best Gen IV level-up detail for a move (prefer Platinum's level).
function gen4LevelUpDetail(refs: RawMoveRef['version_group_details']) {
  const candidates = refs.filter(
    (d) => d.move_learn_method.name === 'level-up' && GEN4_VERSION_GROUPS.includes(d.version_group.name),
  )
  if (candidates.length === 0) return null
  candidates.sort(
    (a, b) =>
      GEN4_VERSION_GROUPS.indexOf(a.version_group.name) - GEN4_VERSION_GROUPS.indexOf(b.version_group.name),
  )
  return candidates[0]
}

interface RawMoveDetail {
  name: string
  type: { name: string }
  damage_class: { name: MoveCategory }
  power: number | null
  accuracy: number | null
  priority: number
  effect_chance: number | null
  effect_entries: { short_effect: string; language: { name: string } }[]
  flavor_text_entries: { flavor_text: string; language: { name: string }; version_group: { name: string } }[]
}

// One-sentence description: prefer the Gen IV in-game flavor text, then any
// English flavor text, then the mechanical short effect.
function moveDescription(data: RawMoveDetail): string {
  const clean = (text: string) => text.replace(/[\n\f\r]+/g, ' ').replace(/\s+/g, ' ').trim()

  const english = data.flavor_text_entries.filter((entry) => entry.language.name === 'en')
  const gen4 = english.find((entry) => GEN4_VERSION_GROUPS.includes(entry.version_group.name))
  const flavor = (gen4 ?? english[0])?.flavor_text
  if (flavor) return clean(flavor)

  const effect = data.effect_entries.find((entry) => entry.language.name === 'en')?.short_effect
  if (effect) return clean(effect).replace('$effect_chance', String(data.effect_chance ?? ''))

  return ''
}

async function loadMove(url: string, levelLearned: number): Promise<Move> {
  const res = await fetch(url)
  if (!res.ok) throw new Error('Move lookup failed.')
  const data = (await res.json()) as RawMoveDetail
  return {
    name: cap(data.name),
    slug: data.name,
    type: cap(data.type.name),
    category: data.damage_class.name,
    power: data.power,
    accuracy: data.accuracy,
    priority: data.priority,
    levelLearned,
    description: moveDescription(data),
  }
}

// Fetch a single move by its API slug (used when swapping moves in the editor).
export async function loadMoveByName(slug: string, levelLearned = 0): Promise<Move> {
  return loadMove(`${API}/move/${slug}`, levelLearned)
}

// Recompute a Pokémon's stats for a new level, keeping everything else.
export function withLevel(pokemon: Pokemon, level: number): Pokemon {
  const clamped = Math.min(100, Math.max(1, Math.round(level)))
  return { ...pokemon, level: clamped, stats: computeStats(pokemon.baseStats, clamped) }
}

// Every move the Pokémon can learn in any Gen IV game, for the move editor.
function buildLearnset(moves: RawMoveRef[]): LearnsetEntry[] {
  const byMove = new Map<string, LearnsetEntry>()
  for (const ref of moves) {
    const gen4 = ref.version_group_details.filter((d) => GEN4_VERSION_GROUPS.includes(d.version_group.name))
    if (gen4.length === 0) continue
    // Prefer a level-up detail so we can show the level it's learned at.
    const levelUp = gen4.find((d) => d.move_learn_method.name === 'level-up')
    const detail = levelUp ?? gen4[0]
    const rawMethod = detail.move_learn_method.name
    const method: LearnsetEntry['method'] =
      rawMethod === 'level-up' || rawMethod === 'machine' || rawMethod === 'tutor' || rawMethod === 'egg'
        ? rawMethod
        : 'other'
    byMove.set(ref.move.name, {
      slug: ref.move.name,
      display: cap(ref.move.name),
      level: levelUp ? levelUp.level_learned_at : 0,
      method,
    })
  }
  const methodOrder = { 'level-up': 0, machine: 1, tutor: 2, egg: 3, other: 4 }
  return [...byMove.values()].sort(
    (a, b) => methodOrder[a.method] - methodOrder[b.method] || a.level - b.level || a.display.localeCompare(b.display),
  )
}

export async function loadPokemon(query: string, level: number, slot: SlotKind): Promise<Pokemon> {
  const clean = normalizeQuery(query)
  if (!clean) throw new Error('Enter a Pokémon name.')

  const res = await fetch(`${API}/pokemon/${clean}`)
  if (!res.ok) throw new Error(`Couldn't find "${query}" in the Pokédex.`)
  const data = (await res.json()) as {
    name: string
    types: { type: { name: string } }[]
    abilities: { ability: { name: string } }[]
    stats: RawStat[]
    moves: RawMoveRef[]
  }

  const baseStats = mapBaseStats(data.stats)

  // Gen IV level-up moves the Pokémon would know at this level. Keep the four
  // learned most recently (highest level ≤ target), matching how the games
  // overwrite the oldest move once a fifth is learned.
  const learnable = data.moves
    .map((ref) => {
      const detail = gen4LevelUpDetail(ref.version_group_details)
      if (!detail) return null
      return { url: ref.move.url, level: detail.level_learned_at }
    })
    .filter((entry): entry is { url: string; level: number } => entry !== null && entry.level <= level)
    .sort((a, b) => a.level - b.level)

  const chosen = learnable.slice(-4)
  const moves = await Promise.all(chosen.map((entry) => loadMove(entry.url, entry.level)))

  return {
    id: `${clean}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: cap(data.name),
    level,
    types: data.types.map((entry) => cap(entry.type.name)),
    abilities: data.abilities.map((entry) => cap(entry.ability.name)),
    baseStats,
    stats: computeStats(baseStats, level),
    moves,
    learnset: buildLearnset(data.moves),
    slot,
  }
}
