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

export interface SwitchSuggestion {
  name: string
  offense: number
  risk: number
  offensiveEff: number // your best move's effectiveness vs the opponent
  defensiveEff: number // opponent's best move's effectiveness vs this mon
  outspeed: boolean
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
  speedLine: string
  bestMoveLine: string
  strategyLine: string
  threatLine: string
}

// Score a matchup. Raw damage/risk plus explicit bonuses for a type advantage
// (super-effective offense, resisted/immune defense) so a benched Pokémon with
// a clear type edge is favoured even when the current mon isn't in danger.
function matchupScore(
  offense: number,
  risk: number,
  outspeed: boolean,
  offEff: number,
  defEff: number,
): number {
  const offBonus = offEff === 0 ? -30 : offEff >= 2 ? 15 : offEff > 1 ? 8 : offEff < 1 ? -8 : 0
  const defBonus = defEff === 0 ? 25 : defEff < 1 ? 12 : defEff > 1 ? -10 : 0
  return offense - risk * 0.6 + (outspeed ? 12 : 0) + offBonus + defBonus
}

function effWord(eff: number): string {
  if (eff === 0) return 'no effect'
  if (eff >= 4) return '4× super effective'
  if (eff > 1) return 'super effective'
  if (eff < 1) return 'not very effective'
  return 'neutral'
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
  const myOffEff = bestMove?.effectiveness ?? 0
  const myDefEff = incomingThreat?.effectiveness ?? 1
  const currentScore = matchupScore(bestMove?.expectedPercent ?? 0, risk, outspeed, myOffEff, myDefEff)

  // Look for a party member with a clearly better matchup — a type advantage
  // (super-effective offense and/or resisting the opponent) is weighted heavily.
  let switchSuggestion: SwitchSuggestion | null = null
  let bestAlt = currentScore + 15 // require a meaningful margin to recommend a swap
  for (const mate of party) {
    if (mate.id === attacker.id) continue
    const mateBest = bestDamagingMove(mate, defender)
    const oppVsMate = bestDamagingMove(defender, mate)
    const mateOffense = mateBest?.expectedPercent ?? 0
    const mateRisk = oppVsMate?.expectedPercent ?? 0
    const mateOffEff = mateBest?.effectiveness ?? 0
    const mateDefEff = oppVsMate?.effectiveness ?? 1
    const mateOutspeed = mate.stats.speed > opponentSpeed
    const score = matchupScore(mateOffense, mateRisk, mateOutspeed, mateOffEff, mateDefEff)
    if (score > bestAlt) {
      bestAlt = score

      // Explain the type advantage in plain terms.
      const offPart = mateBest
        ? mateOffEff > 1
          ? `${mate.name}'s ${mateBest.move.name} is ${effWord(mateOffEff)} (~${Math.round(mateOffense)}%)`
          : `${mate.name} hits for ~${Math.round(mateOffense)}% with ${mateBest.move.name}`
        : `${mate.name} is a better fit`
      const defPart =
        mateDefEff === 0
          ? `, and is immune to ${defender.name}'s best move`
          : mateDefEff < 1
            ? `, and resists it (only ~${Math.round(mateRisk)}% taken)`
            : `, taking ~${Math.round(mateRisk)}% back`
      const speedPart = mateOutspeed ? ', and outspeeds' : ''

      switchSuggestion = {
        name: mate.name,
        offense: mateOffense,
        risk: mateRisk,
        offensiveEff: mateOffEff,
        defensiveEff: mateDefEff,
        outspeed: mateOutspeed,
        reason: `${offPart}${defPart}${speedPart}`,
      }
    }
  }

  const canOhko = bestMove?.ko === 'Guaranteed OHKO' || bestMove?.ko === 'Possible OHKO'
  const threatenedOhko = incomingThreat?.ko === 'Guaranteed OHKO' || incomingThreat?.ko === 'Possible OHKO'

  const speedLine =
    fasterSide === 'you'
      ? `You're faster (${yourSpeed} vs ${opponentSpeed}) — you move first.`
      : fasterSide === 'opponent'
        ? `They're faster (${opponentSpeed} vs ${yourSpeed}) — they move first.`
        : `Speed tie at ${yourSpeed} — 50/50 who moves first.`

  const bestMoveLine = bestMove
    ? `${bestMove.move.name}: ~${Math.round(bestMove.minPercent)}–${Math.round(bestMove.maxPercent)}% (${effWord(
        bestMove.effectiveness,
      )}${bestMove.stab ? ', STAB' : ''}) → ${bestMove.ko}.`
    : `No damaging move lands on ${defender.name}.`

  const threatLine = incomingThreat
    ? `${incomingThreat.move.name}: ~${Math.round(incomingThreat.minPercent)}–${Math.round(
        incomingThreat.maxPercent,
      )}% (${effWord(incomingThreat.effectiveness)}) → ${incomingThreat.ko} on you.`
    : `${defender.name} has no damaging move that lands on you.`

  // Overall strategy: switch vs stay, with the reason spelled out.
  let headline: string
  let strategyLine: string

  if (switchSuggestion) {
    const disadvantage =
      myOffEff === 0
        ? `${attacker.name} can't damage ${defender.name}`
        : myOffEff < 1
          ? `${attacker.name}'s attacks are resisted here`
          : myDefEff > 1
            ? `${attacker.name} is weak to ${defender.name}`
            : threatenedOhko
              ? `${attacker.name} risks being knocked out`
              : `a benched Pokémon has a stronger type matchup`
    headline = `Switch to ${switchSuggestion.name}`
    strategyLine = `Switch out — ${disadvantage}. ${switchSuggestion.reason}.`
  } else if (!bestMove) {
    headline = 'Use a status move or stall'
    strategyLine = `${attacker.name} can't deal damage and no better switch is on the bench — use a status move or stall.`
  } else if (canOhko && outspeed) {
    headline = `Attack with ${bestMove.move.name}`
    strategyLine = `Stay in — you outspeed and ${bestMove.move.name} should KO before ${defender.name} can act.`
  } else if (canOhko && threatenedOhko && !outspeed) {
    headline = `Risky race with ${bestMove.move.name}`
    strategyLine = `Close race — ${bestMove.move.name} can KO, but ${defender.name} moves first and can KO you. No safer switch is available, so weigh the risk.`
  } else if (threatenedOhko && !outspeed) {
    headline = `Attack with ${bestMove.move.name} under pressure`
    strategyLine = `${defender.name} moves first and can KO you — hit hard with ${bestMove.move.name} or take a defensive switch if you have one.`
  } else {
    headline = `Attack with ${bestMove.move.name}`
    strategyLine = `Stay in and attack with ${bestMove.move.name} — it's your strongest available play and you're not in KO range.`
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
    speedLine,
    bestMoveLine,
    strategyLine,
    threatLine,
  }
}
