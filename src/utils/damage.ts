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

// Fixed-damage moves ignore stats and type effectiveness (except immunity),
// dealing a set amount. PokeAPI reports these with power: null, so they must be
// handled explicitly or they'd read as 0 damage. Returns null for normal moves.
function fixedDamage(move: Move, attacker: Pokemon, defender: Pokemon): number | null {
  switch (move.slug ?? move.name.toLowerCase().replace(/\s+/g, '-')) {
    case 'dragon-rage':
      return 40
    case 'sonic-boom':
      return 20
    case 'seismic-toss':
    case 'night-shade':
      return attacker.level // deals damage equal to the user's level
    case 'psywave':
      return attacker.level // 0.5–1.5× level; use the average
    case 'super-fang':
      return Math.max(1, Math.floor(defender.stats.hp / 2)) // ~half the target's HP
    default:
      return null
  }
}

function damageSpread(attacker: Pokemon, defender: Pokemon, move: Move): { min: number; max: number } {
  // Fixed-damage moves: flat amount unless the target is immune by type.
  const fixed = fixedDamage(move, attacker, defender)
  if (fixed != null) {
    if (typeEffectiveness(move.type, defender.types) === 0) return { min: 0, max: 0 }
    return { min: fixed, max: fixed }
  }

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

// A ranked "who to switch to" candidate.
export interface SwitchOption {
  name: string
  verdict: string
  offense: number
  risk: number
  outspeed: boolean
  reason: string
}

// A situational tactic the current Pokémon can use (setup, status, pivot, …).
export interface TacticalOption {
  label: string
  text: string
}

export interface BattleAdvice {
  fasterSide: 'you' | 'opponent' | 'tie'
  yourSpeed: number
  opponentSpeed: number
  moves: MoveAnalysis[]
  bestMove: MoveAnalysis | null
  incomingThreat: MoveAnalysis | null
  switchSuggestion: SwitchSuggestion | null
  switchOptions: SwitchOption[]
  gamePlan: string[] // multi-stage / turn-by-turn plan
  tacticalOptions: TacticalOption[]
  headline: string
  speedLine: string
  bestMoveLine: string
  strategyLine: string
  threatLine: string
}

// Gen IV move classifications used to surface tactical options. Keyed by API slug.
const OFFENSE_SETUP = new Set([
  'swords-dance', 'dragon-dance', 'nasty-plot', 'calm-mind', 'bulk-up', 'agility',
  'rock-polish', 'growth', 'belly-drum', 'tail-glow', 'meditate', 'sharpen', 'howl', 'curse',
])
const CRIPPLE_STATUS = new Set([
  'thunder-wave', 'will-o-wisp', 'toxic', 'spore', 'sleep-powder', 'hypnosis', 'sing',
  'grass-whistle', 'lovely-kiss', 'stun-spore', 'glare', 'yawn', 'confuse-ray',
  'poison-powder', 'leech-seed',
])
const HAZARDS = new Set(['stealth-rock', 'spikes', 'toxic-spikes'])
const RECOVERY = new Set([
  'recover', 'roost', 'rest', 'soft-boiled', 'moonlight', 'morning-sun', 'synthesis',
  'slack-off', 'milk-drink', 'wish', 'heal-order', 'aqua-ring', 'ingrain',
])
const PIVOT = new Set(['u-turn', 'baton-pass'])

function moveSlug(move: Move): string {
  return move.slug ?? move.name.toLowerCase().replace(/\s+/g, '-')
}

function findMove(attacker: Pokemon, set: Set<string>): Move | undefined {
  return attacker.moves.find((move) => set.has(moveSlug(move)))
}

// Short verb describing what a crippling status move does, for plan text.
function statusEffect(slug: string): string {
  if (['thunder-wave', 'stun-spore', 'glare'].includes(slug)) return 'paralyze it (and likely outspeed)'
  if (slug === 'will-o-wisp') return 'burn it (halving its physical damage)'
  if (slug === 'toxic') return 'badly poison it'
  if (['spore', 'sleep-powder', 'hypnosis', 'sing', 'grass-whistle', 'lovely-kiss'].includes(slug)) return 'put it to sleep'
  if (slug === 'leech-seed') return 'sap its HP each turn'
  if (slug === 'confuse-ray') return 'confuse it'
  if (slug === 'yawn') return 'force it to sleep or switch'
  return 'cripple it'
}

// Collapse a damage % spread to a single value when the roll is fixed.
function rangePct(minPct: number, maxPct: number): string {
  const a = Math.round(minPct)
  const b = Math.round(maxPct)
  return a === b ? `${a}%` : `${a}–${b}%`
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

  // Rank every benched Pokémon as a switch-in. A type advantage (super-effective
  // offense and/or resisting the opponent) is weighted heavily.
  const alternatives = party
    .filter((mate) => mate.id !== attacker.id)
    .map((mate) => {
      const mateBest = bestDamagingMove(mate, defender)
      const oppVsMate = bestDamagingMove(defender, mate)
      const offense = mateBest?.expectedPercent ?? 0
      const risk = oppVsMate?.expectedPercent ?? 0
      const offEff = mateBest?.effectiveness ?? 0
      const defEff = oppVsMate?.effectiveness ?? 1
      const outspeed = mate.stats.speed > opponentSpeed
      const score = matchupScore(offense, risk, outspeed, offEff, defEff)

      const offPart = mateBest
        ? offEff > 1
          ? `${mate.name}'s ${mateBest.move.name} is ${effWord(offEff)} (~${Math.round(offense)}%)`
          : `${mate.name} hits for ~${Math.round(offense)}% with ${mateBest.move.name}`
        : `${mate.name} is a decent fit`
      const defPart =
        defEff === 0
          ? `, immune to ${defender.name}'s best move`
          : defEff < 1
            ? `, resists it (~${Math.round(risk)}% taken)`
            : `, takes ~${Math.round(risk)}% back`
      const speedPart = outspeed ? ', outspeeds' : ''

      const verdict =
        offEff > 1 && defEff < 1
          ? 'Ideal counter'
          : defEff === 0
            ? 'Immune wall'
            : offEff > 1 && outspeed
              ? 'Fast attacker'
              : offEff > 1
                ? 'Offensive answer'
                : defEff < 1
                  ? 'Defensive pivot'
                  : risk > 60
                    ? 'Risky'
                    : 'Even matchup'

      return { mate, name: mate.name, offense, risk, offEff, defEff, outspeed, score, mateBest, verdict, reason: `${offPart}${defPart}${speedPart}` }
    })
    .sort((a, b) => b.score - a.score)

  // Only surface benched mons that actually help (better than staying, or a real
  // type edge). Cap at three so the UI stays scannable.
  const switchOptions: SwitchOption[] = alternatives
    .filter((alt) => alt.score > currentScore - 5 || alt.offEff > 1 || alt.defEff < 1)
    .slice(0, 3)
    .map((alt) => ({
      name: alt.name,
      verdict: alt.verdict,
      offense: alt.offense,
      risk: alt.risk,
      outspeed: alt.outspeed,
      // Drop the leading name since the card already shows it as a heading.
      reason: alt.reason.replace(new RegExp(`^${alt.name}('s)? ?`), ''),
    }))

  // The single best benched matchup. A tiny epsilon avoids flip-flopping between
  // essentially-equal Pokémon; anything clearly better than the active is flagged
  // so that only the strongest option is ever told to "stay in".
  const top = alternatives[0]
  const switchSuggestion: SwitchSuggestion | null =
    top && top.score > currentScore + 1
      ? {
          name: top.name,
          offense: top.offense,
          risk: top.risk,
          offensiveEff: top.offEff,
          defensiveEff: top.defEff,
          outspeed: top.outspeed,
          reason: top.reason,
        }
      : null

  const canOhko = bestMove?.ko === 'Guaranteed OHKO' || bestMove?.ko === 'Possible OHKO'
  const threatenedOhko = incomingThreat?.ko === 'Guaranteed OHKO' || incomingThreat?.ko === 'Possible OHKO'

  // Best defensive pivot (takes least) and best offensive answer (hits hardest).
  const bestDefensiveSwitch = [...alternatives].sort((a, b) => a.risk - b.risk)[0]
  const bestOffensiveSwitch = [...alternatives].sort((a, b) => b.offense - a.offense)[0]

  // Classify the current Pokémon's own toolkit for tactical options.
  const setupMove = findMove(attacker, OFFENSE_SETUP)
  const crippleMove = findMove(attacker, CRIPPLE_STATUS)
  const hazardMove = findMove(attacker, HAZARDS)
  const recoveryMove = findMove(attacker, RECOVERY)
  const pivotMove = findMove(attacker, PIVOT)
  const priorityMove = moves.find((m) => m.maxDamage > 0 && m.move.priority > 0) ?? null

  const speedLine =
    fasterSide === 'you'
      ? `You're faster (${yourSpeed} vs ${opponentSpeed}) — you move first.`
      : fasterSide === 'opponent'
        ? `They're faster (${opponentSpeed} vs ${yourSpeed}) — they move first.`
        : `Speed tie at ${yourSpeed} — 50/50 who moves first.`

  const bestMoveLine = bestMove
    ? `${bestMove.move.name}: ~${rangePct(bestMove.minPercent, bestMove.maxPercent)} (${effWord(
        bestMove.effectiveness,
      )}${bestMove.stab ? ', STAB' : ''}) → ${bestMove.ko}.`
    : `No damaging move lands on ${defender.name}.`

  const threatLine = incomingThreat
    ? `${incomingThreat.move.name}: ~${rangePct(incomingThreat.minPercent, incomingThreat.maxPercent)} (${effWord(
        incomingThreat.effectiveness,
      )}) → ${incomingThreat.ko} on you.`
    : `${defender.name} has no damaging move that lands on you.`

  // Decide whether the active Pokémon is actually the play. Only stay in if it's
  // the best matchup on the team, or if it simply wins this turn (KO + outspeed).
  const guaranteedOhko = bestMove?.ko === 'Guaranteed OHKO'
  const twoHKO = bestMove?.ko === 'Guaranteed 2HKO'
  const theyTwoHKO = incomingThreat?.ko === 'Guaranteed 2HKO'
  const winningNow = !!bestMove && outspeed && guaranteedOhko
  const shouldStay = winningNow || !switchSuggestion
  const pct = (n: number) => Math.round(n)

  let headline: string
  let strategyLine: string

  if (!shouldStay && switchSuggestion) {
    // A benched Pokémon is clearly better — recommend the switch, graded by how
    // bad the current matchup is.
    const sug = switchSuggestion
    const graded =
      myOffEff === 0
        ? `${attacker.name} can't damage ${defender.name}`
        : threatenedOhko && !outspeed
          ? `${attacker.name} is in KO range from ${incomingThreat?.move.name}`
          : myDefEff > 1
            ? `${attacker.name} is weak to ${defender.name}`
            : myOffEff < 1
              ? `${attacker.name}'s hits are resisted here`
              : `a stronger matchup is on the bench`
    const serviceable = !threatenedOhko && myOffEff >= 1 && (bestMove?.expectedPercent ?? 0) >= 30
    if (serviceable) {
      headline = `Switch to ${sug.name} (upgrade)`
      strategyLine = `${attacker.name} can fight here, but ${sug.name} is the stronger answer: ${sug.reason}.`
    } else {
      headline = `Switch to ${sug.name}`
      strategyLine = `Switch out — ${graded}. ${sug.name} is the answer: ${sug.reason}.`
    }
  } else if (!bestMove) {
    // Best available Pokémon, but it can't actually damage the opponent.
    headline = crippleMove ? `${crippleMove.name} to stall` : recoveryMove ? `Stall with ${recoveryMove.name}` : 'Stall or pivot'
    strategyLine = `${attacker.name} can't hurt ${defender.name}, and it's still your best option. ${
      crippleMove
        ? `Use ${crippleMove.name} to ${statusEffect(moveSlug(crippleMove))} and chip away`
        : recoveryMove
          ? `Stall with ${recoveryMove.name} and wait it out`
          : pivotMove
            ? `Use ${pivotMove.name} to pivot toward a counter`
            : 'Use a status move or pivot to make progress'
    }.`
  } else {
    const dmg = rangePct(bestMove.minPercent, bestMove.maxPercent)
    const acc = bestMove.move.accuracy ?? 100
    const shaky = acc < 90
    const priorityKOs =
      !!priorityMove && (priorityMove.ko === 'Guaranteed OHKO' || priorityMove.ko === 'Possible OHKO')
    const setupSafe = !!setupMove && !threatenedOhko && !theyTwoHKO && !guaranteedOhko

    if (guaranteedOhko && outspeed) {
      headline = `KO with ${bestMove.move.name}`
      strategyLine = `Clean kill — you outspeed and ${bestMove.move.name} is a guaranteed OHKO (~${dmg}).${shaky ? ` Just mind the ${acc}% accuracy.` : ''}`
    } else if (canOhko && outspeed) {
      headline = `Likely KO with ${bestMove.move.name}`
      strategyLine = `${bestMove.move.name} can OHKO (~${dmg}) and you move first — likely a kill, but it's a damage roll. You still outspeed if it lives${threatenedOhko ? `, though it would KO back, so keep a follow-up ready` : ''}.`
    } else if (canOhko && !outspeed && threatenedOhko) {
      if (priorityKOs && priorityMove) {
        headline = `Finish with ${priorityMove.move.name}`
        strategyLine = `You lose the speed race, but ${priorityMove.move.name} has priority and can KO first (~${pct(priorityMove.minPercent)}–${pct(priorityMove.maxPercent)}%).`
      } else {
        headline = `Risky race with ${bestMove.move.name}`
        strategyLine = `${defender.name} outspeeds and can OHKO you, and your KO won't strike first. This is still your best matchup — gamble on ${bestMove.move.name}${shaky ? ` (~${acc}% acc)` : ''}, or sacrifice a chip to bring ${attacker.name} back in safely.`
      }
    } else if (canOhko && !outspeed) {
      headline = `Attack with ${bestMove.move.name}`
      strategyLine = `You OHKO ${defender.name}. It's faster, but its ${incomingThreat?.move.name ?? 'attack'} only does ~${pct(risk)}%, so you take one hit and KO.`
    } else if (setupSafe && setupMove) {
      headline = `Set up with ${setupMove.name}`
      strategyLine = `${defender.name} can't 2HKO you (${incomingThreat ? `${incomingThreat.move.name} ~${pct(risk)}%` : 'minimal chip'}), so boost with ${setupMove.name}, then sweep with ${bestMove.move.name} at +power.`
    } else if (!outspeed && crippleMove && !threatenedOhko) {
      headline = `${crippleMove.name} to flip momentum`
      strategyLine = `${defender.name} outspeeds you — lead with ${crippleMove.name} to ${statusEffect(moveSlug(crippleMove))}, then attack with ${bestMove.move.name}.`
    } else if (recoveryMove && myDefEff < 1) {
      headline = `Stall with ${recoveryMove.name}`
      strategyLine = `You resist ${defender.name} (~${pct(risk)}% per hit). Chip with ${bestMove.move.name} and heal with ${recoveryMove.name} to grind it down safely.`
    } else if (twoHKO && outspeed) {
      headline = `2HKO with ${bestMove.move.name}`
      strategyLine = `${bestMove.move.name} 2HKOs (~${dmg} each) and you outspeed, so KO over two turns${incomingThreat ? `, surviving ${incomingThreat.move.name} (~${pct(risk)}%) in between` : ''}.`
    } else if (threatenedOhko && !outspeed) {
      headline = priorityMove ? `Chip with ${priorityMove.move.name}` : `Attack with ${bestMove.move.name}`
      strategyLine = `${defender.name} moves first and can KO you, and it's still your best matchup. ${
        priorityMove ? `Get in priority ${priorityMove.move.name} damage` : `Deal what you can with ${bestMove.move.name}`
      }${hazardMove ? ` or set ${hazardMove.name} before going down` : ''} — or sacrifice to bring in a counter.`
    } else if (bestMove.expectedPercent < 12 && risk < 15) {
      headline = hazardMove ? `Set ${hazardMove.name}` : crippleMove ? `${crippleMove.name}` : pivotMove ? `Pivot with ${pivotMove.name}` : 'Break the stall'
      strategyLine = `Neither of you does much (you ~${pct(bestMove.expectedPercent)}%, them ~${pct(risk)}%). ${
        hazardMove
          ? `Set ${hazardMove.name} to punish switches`
          : crippleMove
            ? `Use ${crippleMove.name} to ${statusEffect(moveSlug(crippleMove))}`
            : pivotMove
              ? `Pivot with ${pivotMove.name}`
              : 'Use status or pivot'
      } to make progress.`
    } else {
      headline = `Attack with ${bestMove.move.name}`
      strategyLine = `Stay in — ${bestMove.move.name} is your best play (~${dmg}, ${bestMove.ko.toLowerCase()}) and you're not in KO range.${shaky ? ` Mind the ${acc}% accuracy.` : ''}`
    }
  }

  // Multi-stage game plan — the concrete turn-by-turn sequence to execute.
  const gamePlan: string[] = []
  const survivesAHit = !threatenedOhko
  const safeThreat = incomingThreat ? `${incomingThreat.move.name} (~${Math.round(risk)}%)` : 'its attack'

  if (!shouldStay && switchSuggestion) {
    // Pivot plan: soak the hit with your best wall, then bring in your best attacker.
    const wall = bestDefensiveSwitch
    const sweeper = bestOffensiveSwitch
    if (wall && sweeper && wall.name !== sweeper.name && wall.defEff < 1) {
      gamePlan.push(`Turn 1: switch to ${wall.name} to absorb ${safeThreat}.`)
      gamePlan.push(`Turn 2: pivot to ${sweeper.name} and attack with ${sweeper.mateBest?.move.name ?? 'its best move'} (~${Math.round(sweeper.offense)}%).`)
    } else {
      gamePlan.push(`Turn 1: switch to ${switchSuggestion.name} (${top.verdict.toLowerCase()}).`)
      if (top?.mateBest) gamePlan.push(`Turn 2: attack with ${top.mateBest.move.name} (~${Math.round(top.offense)}%).`)
    }
  } else if (setupMove && survivesAHit && bestMove && !canOhko) {
    gamePlan.push(`Turn 1: set up with ${setupMove.name} — ${defender.name} only does ${safeThreat}, so you can afford it.`)
    gamePlan.push(`Turn 2+: sweep with ${bestMove.move.name} at boosted power.`)
  } else if (!outspeed && crippleMove && bestMove) {
    gamePlan.push(`Turn 1: ${crippleMove.name} to ${statusEffect(moveSlug(crippleMove))}.`)
    gamePlan.push(`Turn 2+: attack with ${bestMove.move.name} with the momentum flipped.`)
  } else if (outspeed && bestMove?.ko === 'Guaranteed 2HKO' && survivesAHit) {
    gamePlan.push(`Turn 1: ${bestMove.move.name} (~${Math.round(bestMove.expectedPercent)}%).`)
    gamePlan.push(`Turn 2: ${bestMove.move.name} again to KO — you outspeed and survive ${safeThreat} between hits.`)
  } else if (canOhko && outspeed && bestMove) {
    gamePlan.push(`Turn 1: ${bestMove.move.name} — you outspeed and should KO before ${defender.name} acts.`)
  } else if (threatenedOhko && !outspeed && bestMove) {
    if (priorityMove) {
      gamePlan.push(`Turn 1: ${priorityMove.move.name} strikes first (priority) for ~${Math.round(priorityMove.expectedPercent)}%.`)
      gamePlan.push('If it doesn’t KO, switch to a safer matchup next turn.')
    } else {
      gamePlan.push(`Turn 1: ${bestMove.move.name} and hope to KO — otherwise ${defender.name} KOs you back.`)
      if (bestDefensiveSwitch && bestDefensiveSwitch.defEff < 1) {
        gamePlan.push(`Safer line: switch to ${bestDefensiveSwitch.name} to absorb ${safeThreat} first.`)
      }
    }
  } else if (bestMove) {
    gamePlan.push(`Turn 1+: keep attacking with ${bestMove.move.name} — you're not in KO range.`)
    if (bestMove.ko === 'Guaranteed 2HKO' || bestMove.ko === '3+ hits') {
      gamePlan.push(`Watch your HP; ${defender.name} chips ~${Math.round(risk)}% per turn.`)
    }
  } else {
    gamePlan.push('No damage available — pivot out or use a status move to make progress.')
  }

  // Situational tactical menu — the "other options" beyond the main plan.
  const tacticalOptions: TacticalOption[] = []
  if (!outspeed && priorityMove) {
    tacticalOptions.push({
      label: 'Strike first',
      text: `${priorityMove.move.name} has priority — it hits before ${defender.name} even though you're slower.`,
    })
  }
  if (setupMove && survivesAHit) {
    tacticalOptions.push({
      label: 'Set up',
      text: `${setupMove.name} boosts you; ${defender.name} only does ${safeThreat}, so there's room to power up.`,
    })
  }
  if (crippleMove) {
    tacticalOptions.push({
      label: 'Cripple',
      text: `${crippleMove.name} can ${statusEffect(moveSlug(crippleMove))} to blunt ${defender.name}.`,
    })
  }
  if (hazardMove) {
    tacticalOptions.push({
      label: 'Hazards',
      text: `${hazardMove.name} chips their team every time a Pokémon switches in.`,
    })
  }
  if (recoveryMove && myDefEff < 1) {
    tacticalOptions.push({
      label: 'Stall',
      text: `You resist ${defender.name}, so ${recoveryMove.name} lets you outlast it.`,
    })
  }
  if (pivotMove) {
    tacticalOptions.push({
      label: 'Pivot',
      text: `${pivotMove.name} lets you ${pivotMove.name === 'Baton Pass' ? 'pass boosts and ' : 'deal damage and '}switch to a better matchup.`,
    })
  }

  return {
    fasterSide,
    yourSpeed,
    opponentSpeed,
    moves,
    bestMove,
    incomingThreat,
    switchSuggestion,
    switchOptions,
    gamePlan,
    tacticalOptions,
    headline,
    speedLine,
    bestMoveLine,
    strategyLine,
    threatLine,
  }
}
