// Core data model + Gen IV (Pokémon Platinum) type chart.

export type MoveCategory = 'physical' | 'special' | 'status'

export interface Move {
  name: string
  slug: string // API name, used to match against the learnset
  type: string
  category: MoveCategory
  power: number | null
  accuracy: number | null
  priority: number
  levelLearned: number
  description: string // one-sentence summary of what the move does
}

// A move the Pokémon can learn in Gen IV, used to populate the move editor.
export interface LearnsetEntry {
  slug: string
  display: string
  level: number // level-up level; 0 for TM/HM, tutor, or egg moves
  method: 'level-up' | 'machine' | 'tutor' | 'egg' | 'other'
}

export interface Stats {
  hp: number
  attack: number
  defense: number
  spAttack: number
  spDefense: number
  speed: number
}

export type SlotKind = 'party' | 'backpack'

export interface Pokemon {
  id: string
  name: string
  level: number
  types: string[]
  abilities: string[]
  baseStats: Stats
  stats: Stats // computed at the given level
  moves: Move[]
  learnset: LearnsetEntry[] // full Gen IV move pool, for editing
  slot: SlotKind // relevant for your own team; opponents are always 'party'
}

// Gen IV type chart — no Fairy type, and Steel still resists Ghost & Dark
// (that resistance was removed in Gen VI). Only non-neutral matchups are listed.
export const typeChart: Record<string, Record<string, number>> = {
  Normal: { Rock: 0.5, Ghost: 0, Steel: 0.5 },
  Fire: { Fire: 0.5, Water: 0.5, Grass: 2, Ice: 2, Bug: 2, Rock: 0.5, Dragon: 0.5, Steel: 2 },
  Water: { Fire: 2, Water: 0.5, Grass: 0.5, Ground: 2, Rock: 2, Dragon: 0.5 },
  Electric: { Water: 2, Electric: 0.5, Grass: 0.5, Ground: 0, Flying: 2, Dragon: 0.5 },
  Grass: {
    Fire: 0.5, Water: 2, Grass: 0.5, Poison: 0.5, Ground: 2,
    Flying: 0.5, Bug: 0.5, Rock: 2, Dragon: 0.5, Steel: 0.5,
  },
  Ice: { Fire: 0.5, Water: 0.5, Grass: 2, Ice: 0.5, Ground: 2, Flying: 2, Dragon: 2, Steel: 0.5 },
  Fighting: {
    Normal: 2, Ice: 2, Poison: 0.5, Flying: 0.5, Psychic: 0.5,
    Bug: 0.5, Rock: 2, Ghost: 0, Dark: 2, Steel: 2,
  },
  Poison: { Grass: 2, Poison: 0.5, Ground: 0.5, Rock: 0.5, Ghost: 0.5, Steel: 0 },
  Ground: { Fire: 2, Electric: 2, Grass: 0.5, Poison: 2, Flying: 0, Bug: 0.5, Rock: 2, Steel: 2 },
  Flying: { Electric: 0.5, Grass: 2, Fighting: 2, Bug: 2, Rock: 0.5, Steel: 0.5 },
  Psychic: { Fighting: 2, Poison: 2, Psychic: 0.5, Dark: 0, Steel: 0.5 },
  Bug: {
    Fire: 0.5, Grass: 2, Fighting: 0.5, Poison: 0.5, Flying: 0.5,
    Psychic: 2, Ghost: 0.5, Dark: 2, Steel: 0.5,
  },
  Rock: { Fire: 2, Ice: 2, Fighting: 0.5, Ground: 0.5, Flying: 2, Bug: 2, Steel: 0.5 },
  Ghost: { Normal: 0, Psychic: 2, Ghost: 2, Dark: 0.5, Steel: 0.5 },
  Dragon: { Dragon: 2, Steel: 0.5 },
  Dark: { Fighting: 0.5, Psychic: 2, Ghost: 2, Dark: 0.5, Steel: 0.5 },
  Steel: { Fire: 0.5, Water: 0.5, Electric: 0.5, Ice: 2, Rock: 2, Steel: 0.5 },
}
