// Gen IV damage calculation + a battle advisor that recommends the strongest
// action against a specific opponent and explains why.
import { typeChart, type Move, type Pokemon } from '../data/pokemonData'

const STAB = 1.5

export function typeEffectiveness(moveType: string, defenderTypes: string[]): number {
  return defenderTypes.reduce((total, type) => total * (typeChart[moveType]?.[type] ?? 1), 1)
}

export type KoVerdict =
  | 'Guaranteed OHKO'
  | 'Possible OHKO'
  | 'Guaranteed 2HKO'
  | '3+ hits'
  | 'No damage'

export interface MoveAnalysis {
  move: Move
  effectiveness: number
  stab: boolean
  minDamage: number
  maxDamage: number
  minPercent: number
  maxPercent: number
  expectedPercent: number // accuracy-weighted midpoint, used for ranking
  ko: KoVerdict
}

function damageSpread(attacker: Pokemon, defender: Pokemon, move: Move): { min: number; max: number } {
  if (move.category === 'status' || !move.power) return { min: 0, max: 0 }

  const level = attacker.level
  const atk = move.category === 'physical' ? attacker.stats.attack : attacker.stats.spAttack
  const def = move.category === 'physical' ? defender.stats.defense : defender.stats.spDefense

  // Gen IV core formula, then STAB and type effectiveness.
  const core =
    Math.floor(Math.floor((Math.floor((2 * level) / 5 + 2) * move.power * atk) / def) / 50) + 2
  const stab = attacker.types.includes(move.type) ? STAB : 1
  const eff = typeEffectiveness(move.type, defender.types)
  const modified = core * stab * eff

  if (eff === 0) return { min: 0, max: 0 }
  return { min: Math.max(1, Math.floor(modified * 0.85)), max: Math.max(1, Math.floor(modified)) }
}

function verdict(min: number, max: number, hp: number): KoVerdict {
  if (max <= 0) return 'No damage'
  if (min >= hp) return 'Guaranteed OHKO'
  if (max >= hp) return 'Possible OHKO'
  if (min * 2 >= hp) return 'Guaranteed 2HKO'
  return '3+ hits'
}

export function analyzeMove(attacker: Pokemon, defender: Pokemon, move: Move): MoveAnalysis {
  const { min, max } = damageSpread(attacker, defender, move)
  const hp = defender.stats.hp
  const minPercent = (min / hp) * 100
  const maxPercent = (max / hp) * 100
  const accuracy = (move.accuracy ?? 100) / 100
  return {
    move,
    effectiveness: typeEffectiveness(move.type, defender.types),
    stab: attacker.types.includes(move.type),
    minDamage: min,
    maxDamage: max,
    minPercent,
    maxPercent,
    expectedPercent: ((minPercent + maxPercent) / 2) * accuracy,
    ko: verdict(min, max, hp),
  }
}

function bestDamagingMove(attacker: Pokemon, defender: Pokemon): MoveAnalysis | null {
  const damaging = attacker.moves
    .filter((move) => move.category !== 'status' && (move.power ?? 0) > 0)
    .map((move) => analyzeMove(attacker, defender, move))
    .sort((a, b) => b.expectedPercent - a.expectedPercent || b.move.priority - a.move.priority)
  return damaging[0] ?? null
}

// Defensive risk of staying in: how big a chunk the opponent's best move takes.
function incomingRisk(attacker: Pokemon, defender: Pokemon): number {
  const threat = bestDamagingMove(defender, attacker)
  return threat ? threat.expectedPercent : 0
}

export interface SwitchSuggestion {
  name: string
  offense: number
  risk: number
  reason: string
}

export interface BattleAdvice {
  fasterSide: 'you' | 'opponent' | 'tie'
  yourSpeed: number
  opponentSpeed: number
  moves: MoveAnalysis[]
  bestMove: MoveAnalysis | null
  incomingThreat: MoveAnalysis | null
  switchSuggestion: SwitchSuggestion | null
  headline: string
  reasoning: string[]
}

function matchupScore(offense: number, risk: number, outspeed: boolean): number {
  return offense - risk * 0.6 + (outspeed ? 12 : 0)
}

export function analyzeBattle(attacker: Pokemon, defender: Pokemon, party: Pokemon[]): BattleAdvice {
  const yourSpeed = attacker.stats.speed
  const opponentSpeed = defender.stats.speed
  const fasterSide: BattleAdvice['fasterSide'] =
    yourSpeed === opponentSpeed ? 'tie' : yourSpeed > opponentSpeed ? 'you' : 'opponent'
  const outspeed = fasterSide === 'you'

  const moves = attacker.moves
    .map((move) => analyzeMove(attacker, defender, move))
    .sort((a, b) => b.expectedPercent - a.expectedPercent || b.move.priority - a.move.priority)
  const bestMove = moves.find((m) => m.maxDamage > 0) ?? null

  const incomingThreat = bestDamagingMove(defender, attacker)
  const risk = incomingThreat ? incomingThreat.expectedPercent : 0
  const currentScore = matchupScore(bestMove?.expectedPercent ?? 0, risk, outspeed)

  // Look for a party member with a clearly better matchup.
  let switchSuggestion: SwitchSuggestion | null = null
  let bestAlt = currentScore + 20 // require a meaningful margin to recommend a swap
  for (const mate of party) {
    if (mate.id === attacker.id) continue
    const mateBest = bestDamagingMove(mate, defender)
    const mateOffense = mateBest?.expectedPercent ?? 0
    const mateRisk = incomingRisk(mate, defender)
    const mateOutspeed = mate.stats.speed > opponentSpeed
    const score = matchupScore(mateOffense, mateRisk, mateOutspeed)
    if (score > bestAlt) {
      bestAlt = score
      switchSuggestion = {
        name: mate.name,
        offense: mateOffense,
        risk: mateRisk,
        reason:
          `${mate.name} ${mateOutspeed ? 'outspeeds and ' : ''}hits for ~${Math.round(mateOffense)}% ` +
          `while taking ~${Math.round(mateRisk)}% back` +
          (mateBest ? ` with ${mateBest.move.name}` : ''),
      }
    }
  }

  // Build the headline + reasoning.
  const reasoning: string[] = []
  reasoning.push(
    fasterSide === 'you'
      ? `You outspeed (${yourSpeed} vs ${opponentSpeed}) — you move first.`
      : fasterSide === 'opponent'
        ? `Opponent is faster (${opponentSpeed} vs ${yourSpeed}) — they move first.`
        : `Speed tie (${yourSpeed}) — coin flip on who moves first.`,
  )

  if (bestMove) {
    const eff =
      bestMove.effectiveness > 1
        ? 'super effective'
        : bestMove.effectiveness < 1
          ? bestMove.effectiveness === 0
            ? 'no effect'
            : 'not very effective'
          : 'neutral'
    reasoning.push(
      `${bestMove.move.name} is your top damage: ~${Math.round(bestMove.minPercent)}–${Math.round(
        bestMove.maxPercent,
      )}% (${eff}${bestMove.stab ? ', STAB' : ''}) → ${bestMove.ko}.`,
    )
  } else {
    reasoning.push('No damaging move connects — use a status move or switch.')
  }

  if (incomingThreat) {
    reasoning.push(
      `Biggest incoming hit: ${incomingThreat.move.name} for ~${Math.round(
        incomingThreat.minPercent,
      )}–${Math.round(incomingThreat.maxPercent)}% (${incomingThreat.ko} on you).`,
    )
  }

  let headline: string
  const canOhko = bestMove?.ko === 'Guaranteed OHKO' || bestMove?.ko === 'Possible OHKO'
  const threatenedOhko = incomingThreat?.ko === 'Guaranteed OHKO' || incomingThreat?.ko === 'Possible OHKO'

  if (switchSuggestion && (threatenedOhko || (bestMove?.expectedPercent ?? 0) < 20)) {
    headline = `Switch to ${switchSuggestion.name}`
    reasoning.push(`Better option available: ${switchSuggestion.reason}.`)
  } else if (bestMove && canOhko && outspeed) {
    headline = `Attack with ${bestMove.move.name} — you should KO first`
  } else if (bestMove && canOhko && threatenedOhko) {
    headline = `Race: use ${bestMove.move.name}, but they can KO you back`
    reasoning.push('You lose the speed race, so this is a risk — a switch may be safer.')
  } else if (bestMove) {
    headline = `Attack with ${bestMove.move.name}`
  } else if (switchSuggestion) {
    headline = `Switch to ${switchSuggestion.name}`
  } else {
    headline = 'Use a status move or stall'
  }

  return {
    fasterSide,
    yourSpeed,
    opponentSpeed,
    moves,
    bestMove,
    incomingThreat,
    switchSuggestion,
    headline,
    reasoning,
  }
}
