import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { type Pokemon, type SlotKind } from './data/pokemonData'
import {
  fetchPokemonNames,
  loadMoveByName,
  loadPokemon,
  resolvePokemonName,
  suggestNames,
  withLevel,
} from './utils/pokeapi'
import { analyzeBattle, analyzeMove, type MoveAnalysis } from './utils/damage'

const PARTY_LIMIT = 6
const STORAGE_KEY = 'pp-strategist-team-v1'

// Load the saved party + backpack once, tolerating any legacy/corrupt payload.
function loadSavedTeam(): { party: Pokemon[]; backpack: Pokemon[] } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { party: [], backpack: [] }
    const parsed = JSON.parse(raw) as { party?: Pokemon[]; backpack?: Pokemon[] }
    return {
      party: Array.isArray(parsed.party) ? parsed.party : [],
      backpack: Array.isArray(parsed.backpack) ? parsed.backpack : [],
    }
  } catch {
    return { party: [], backpack: [] }
  }
}

function prettyName(slug: string): string {
  return slug
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function effectivenessLabel(value: number): string {
  if (value === 0) return 'No effect'
  if (value >= 4) return '4× super effective'
  if (value > 1) return `${value}× super effective`
  if (value < 1) return `${value}× resisted`
  return 'Neutral'
}

function effClass(value: number): string {
  if (value === 0) return 'eff-none'
  if (value > 1) return 'eff-super'
  if (value < 1) return 'eff-weak'
  return 'eff-neutral'
}

function StatBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat-cell">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  )
}

const METHOD_LABELS: Record<string, string> = {
  'level-up': 'Level-up',
  machine: 'TM / HM',
  tutor: 'Move Tutor',
  egg: 'Egg Move',
  other: 'Other',
}

function MoveEditor({
  pokemon,
  onSetMove,
  onRemoveMove,
  pendingSlot,
}: {
  pokemon: Pokemon
  onSetMove: (slotIndex: number, slug: string) => void
  onRemoveMove: (slotIndex: number) => void
  pendingSlot: number | null
}) {
  const known = new Set(pokemon.moves.map((m) => m.slug))
  const learnset = pokemon.learnset ?? []

  // Group the pool by learn method for the dropdown, hiding already-known moves.
  const grouped = learnset.reduce<Record<string, typeof learnset>>((acc, entry) => {
    if (known.has(entry.slug)) return acc
    ;(acc[entry.method] ??= []).push(entry)
    return acc
  }, {})

  function renderOptions() {
    return Object.entries(grouped).map(([method, entries]) => (
      <optgroup key={method} label={METHOD_LABELS[method] ?? method}>
        {entries.map((entry) => (
          <option key={entry.slug} value={entry.slug}>
            {entry.display}
            {entry.method === 'level-up' && entry.level > 0 ? ` (Lv ${entry.level})` : ''}
          </option>
        ))}
      </optgroup>
    ))
  }

  const slots = [0, 1, 2, 3]

  return (
    <div className="move-editor">
      {learnset.length === 0 ? (
        <p className="hint">Re-add this Pokémon to load its editable move pool.</p>
      ) : (
        slots.map((index) => {
          const move = pokemon.moves[index]
          const busy = pendingSlot === index
          return (
            <div className="move-slot" key={index}>
              <span className="slot-num">{index + 1}</span>
              <select
                value=""
                disabled={busy}
                onChange={(e) => {
                  if (e.target.value) onSetMove(index, e.target.value)
                }}
              >
                <option value="">{busy ? 'Loading…' : move ? `Change ${move.name}…` : 'Add a move…'}</option>
                {renderOptions()}
              </select>
              {move ? (
                <button type="button" className="ghost danger tiny" onClick={() => onRemoveMove(index)}>
                  ✕
                </button>
              ) : (
                <span className="slot-empty">empty</span>
              )}
            </div>
          )
        })
      )}
    </div>
  )
}

function PokemonCard({
  pokemon,
  onRemove,
  onMove,
  moveLabel,
  editable,
  onLevelChange,
  onSetMove,
  onRemoveMove,
  pendingSlot,
}: {
  pokemon: Pokemon
  onRemove: () => void
  onMove?: () => void
  moveLabel?: string
  editable?: boolean
  onLevelChange?: (level: number) => void
  onSetMove?: (slotIndex: number, slug: string) => void
  onRemoveMove?: (slotIndex: number) => void
  pendingSlot?: number | null
}) {
  const [editing, setEditing] = useState(false)

  return (
    <article className={`mon-card${editing ? ' editing' : ''}`}>
      <div className="mon-head">
        <div>
          <h3>
            {pokemon.name} <span className="mon-level">Lv {pokemon.level}</span>
          </h3>
          <div className="type-row">
            {pokemon.types.map((type) => (
              <span key={type} className={`type-chip type-${type.toLowerCase()}`}>
                {type}
              </span>
            ))}
          </div>
        </div>
        <div className="mon-actions">
          {editable ? (
            <button type="button" className="ghost" onClick={() => setEditing((v) => !v)}>
              {editing ? 'Done' : 'Edit'}
            </button>
          ) : null}
          {onMove && moveLabel ? (
            <button type="button" className="ghost" onClick={onMove}>
              {moveLabel}
            </button>
          ) : null}
          <button type="button" className="ghost danger" onClick={onRemove}>
            Remove
          </button>
        </div>
      </div>

      {editing && onLevelChange ? (
        <div className="level-editor">
          <span>Level</span>
          <button type="button" className="ghost" onClick={() => onLevelChange(pokemon.level - 1)}>
            −
          </button>
          <input
            type="number"
            min={1}
            max={100}
            value={pokemon.level}
            onChange={(e) => onLevelChange(Number(e.target.value) || 1)}
          />
          <button type="button" className="ghost" onClick={() => onLevelChange(pokemon.level + 1)}>
            +
          </button>
          <span className="hint level-hint">Stats update automatically.</span>
        </div>
      ) : null}

      <div className="stat-grid">
        <StatBar label="HP" value={pokemon.stats.hp} />
        <StatBar label="Atk" value={pokemon.stats.attack} />
        <StatBar label="Def" value={pokemon.stats.defense} />
        <StatBar label="SpA" value={pokemon.stats.spAttack} />
        <StatBar label="SpD" value={pokemon.stats.spDefense} />
        <StatBar label="Spe" value={pokemon.stats.speed} />
      </div>

      {editing && onSetMove && onRemoveMove ? (
        <MoveEditor
          pokemon={pokemon}
          onSetMove={onSetMove}
          onRemoveMove={onRemoveMove}
          pendingSlot={pendingSlot ?? null}
        />
      ) : (
        <div className="mon-moves">
          {pokemon.moves.length === 0 ? (
            <span className="hint">No Gen IV level-up moves at this level.</span>
          ) : (
            pokemon.moves.map((move) => (
              <span key={move.slug ?? move.name} className={`move-chip type-${move.type.toLowerCase()}`}>
                {move.name}
                <small>{move.category === 'status' ? 'Status' : `${move.power ?? '—'} pow`}</small>
              </span>
            ))
          )}
        </div>
      )}
      {pokemon.abilities.length > 0 ? (
        <p className="ability-line">Ability: {pokemon.abilities.join(' / ')}</p>
      ) : null}
    </article>
  )
}

function App() {
  const saved = useRef(loadSavedTeam())
  const [party, setParty] = useState<Pokemon[]>(saved.current.party)
  const [backpack, setBackpack] = useState<Pokemon[]>(saved.current.backpack)
  const [opponents, setOpponents] = useState<Pokemon[]>([])

  const [nameIndex, setNameIndex] = useState<string[]>([])

  const [teamName, setTeamName] = useState('')
  const [teamLevel, setTeamLevel] = useState('5')
  const [teamTarget, setTeamTarget] = useState<SlotKind>('party')
  const [oppName, setOppName] = useState('')
  const [oppLevel, setOppLevel] = useState('5')

  const [teamError, setTeamError] = useState('')
  const [teamInfo, setTeamInfo] = useState('')
  const [oppError, setOppError] = useState('')
  const [oppInfo, setOppInfo] = useState('')
  const [teamLoading, setTeamLoading] = useState(false)
  const [oppLoading, setOppLoading] = useState(false)

  const [combatMode, setCombatMode] = useState(false)
  const [activeId, setActiveId] = useState('')
  const [oppActiveId, setOppActiveId] = useState('')
  const [pending, setPending] = useState<{ id: string; slot: number } | null>(null)

  // Persist only the player's team (party + backpack), not opponents.
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ party, backpack }))
  }, [party, backpack])

  // Load the searchable name index once for typo-tolerant lookups.
  useEffect(() => {
    let ignore = false
    fetchPokemonNames()
      .then((names) => {
        if (!ignore) setNameIndex(names)
      })
      .catch(() => {})
    return () => {
      ignore = true
    }
  }, [])

  const teamSuggestions = useMemo(
    () => suggestNames(teamName, nameIndex),
    [teamName, nameIndex],
  )
  const oppSuggestions = useMemo(() => suggestNames(oppName, nameIndex), [oppName, nameIndex])

  async function handleAddTeam(event: React.FormEvent) {
    event.preventDefault()
    setTeamError('')
    setTeamInfo('')
    const resolution = resolvePokemonName(teamName, nameIndex)
    if (!resolution.matched && resolution.suggestions.length > 0) {
      setTeamError(`No exact match for "${teamName}". Try: ${resolution.suggestions.slice(0, 4).map(prettyName).join(', ')}`)
      return
    }
    const level = Math.min(100, Math.max(1, Number(teamLevel) || 1))
    setTeamLoading(true)
    try {
      const target: SlotKind = teamTarget === 'party' && party.length >= PARTY_LIMIT ? 'backpack' : teamTarget
      const mon = await loadPokemon(resolution.name, level, target)
      if (target === 'party') setParty((current) => [...current, mon])
      else setBackpack((current) => [...current, mon])
      if (resolution.corrected) setTeamInfo(`Loaded ${mon.name} for "${teamName}".`)
      setTeamName('')
    } catch (error) {
      setTeamError(error instanceof Error ? error.message : 'Failed to load Pokémon.')
    } finally {
      setTeamLoading(false)
    }
  }

  async function handleAddOpponent(event: React.FormEvent) {
    event.preventDefault()
    setOppError('')
    setOppInfo('')
    const resolution = resolvePokemonName(oppName, nameIndex)
    if (!resolution.matched && resolution.suggestions.length > 0) {
      setOppError(`No exact match for "${oppName}". Try: ${resolution.suggestions.slice(0, 4).map(prettyName).join(', ')}`)
      return
    }
    const level = Math.min(100, Math.max(1, Number(oppLevel) || 1))
    setOppLoading(true)
    try {
      const mon = await loadPokemon(resolution.name, level, 'party')
      setOpponents((current) => [...current, mon])
      if (resolution.corrected) setOppInfo(`Loaded ${mon.name} for "${oppName}".`)
      setOppName('')
    } catch (error) {
      setOppError(error instanceof Error ? error.message : 'Failed to load Pokémon.')
    } finally {
      setOppLoading(false)
    }
  }

  function moveToBackpack(id: string) {
    const mon = party.find((entry) => entry.id === id)
    if (!mon) return
    setParty((current) => current.filter((entry) => entry.id !== id))
    setBackpack((current) => [...current, { ...mon, slot: 'backpack' }])
  }

  function moveToParty(id: string) {
    if (party.length >= PARTY_LIMIT) {
      setTeamError('Party is full (6). Remove or bench a Pokémon first.')
      return
    }
    const mon = backpack.find((entry) => entry.id === id)
    if (!mon) return
    setBackpack((current) => current.filter((entry) => entry.id !== id))
    setParty((current) => [...current, { ...mon, slot: 'party' }])
  }

  // Apply an update to whichever of my lists (party/backpack) holds this mon.
  function updateMyPokemon(id: string, updater: (mon: Pokemon) => Pokemon) {
    setParty((current) => current.map((mon) => (mon.id === id ? updater(mon) : mon)))
    setBackpack((current) => current.map((mon) => (mon.id === id ? updater(mon) : mon)))
  }

  function changeLevel(id: string, level: number) {
    updateMyPokemon(id, (mon) => withLevel(mon, level))
  }

  async function setSlotMove(id: string, slotIndex: number, slug: string) {
    const mon = [...party, ...backpack].find((entry) => entry.id === id)
    if (!mon) return
    const entry = mon.learnset?.find((item) => item.slug === slug)
    setPending({ id, slot: slotIndex })
    try {
      const move = await loadMoveByName(slug, entry?.level ?? 0)
      updateMyPokemon(id, (current) => {
        const moves = [...current.moves]
        if (slotIndex < moves.length) moves[slotIndex] = move
        else moves.push(move)
        return { ...current, moves }
      })
    } catch {
      setTeamError(`Couldn't load ${prettyName(slug)}.`)
    } finally {
      setPending(null)
    }
  }

  function removeSlotMove(id: string, slotIndex: number) {
    updateMyPokemon(id, (mon) => ({
      ...mon,
      moves: mon.moves.filter((_, index) => index !== slotIndex),
    }))
  }

  function clearTeam() {
    setParty([])
    setBackpack([])
    setActiveId('')
    setCombatMode(false)
  }

  function clearOpponents() {
    setOpponents([])
    setOppActiveId('')
    setCombatMode(false)
  }

  function startCombat() {
    if (party.length === 0 || opponents.length === 0) return
    setActiveId(party[0].id)
    setOppActiveId(opponents[0].id)
    setCombatMode(true)
  }

  const active = useMemo(() => party.find((p) => p.id === activeId) ?? party[0] ?? null, [party, activeId])
  const oppActive = useMemo(
    () => opponents.find((p) => p.id === oppActiveId) ?? opponents[0] ?? null,
    [opponents, oppActiveId],
  )

  const advice = useMemo(() => {
    if (!active || !oppActive) return null
    return analyzeBattle(active, oppActive, party)
  }, [active, oppActive, party])

  // Which of your team best answers the current opponent (offense vs risk).
  const teamRanking = useMemo(() => {
    if (!oppActive) return []
    return [...party]
      .map((mon) => {
        const damaging = mon.moves
          .filter((m) => m.category !== 'status' && (m.power ?? 0) > 0)
          .map((m) => analyzeMove(mon, oppActive, m))
          .sort((a, b) => b.expectedPercent - a.expectedPercent)
        const best = damaging[0]
        return {
          name: mon.name,
          id: mon.id,
          bestMove: best?.move.name ?? '—',
          percent: best ? Math.round(best.expectedPercent) : 0,
          outspeed: mon.stats.speed > oppActive.stats.speed,
        }
      })
      .sort((a, b) => b.percent - a.percent)
  }, [party, oppActive])

  return (
    <div className="app-shell">
      <header className="hero-card">
        <div>
          <p className="eyebrow">Pokémon Platinum · Gen IV</p>
          <h1>Battle Strategist</h1>
          <p className="hero-copy">
            Enter a Pokémon and its level to auto-load its Platinum level-up moveset. Build your party
            and backpack, log the opponent&apos;s team, then start combat for the optimal play.
          </p>
        </div>
        <div className="hero-actions">
          {!combatMode ? (
            <button
              type="button"
              className="primary big"
              disabled={party.length === 0 || opponents.length === 0}
              onClick={startCombat}
            >
              ⚔️ Combat Start
            </button>
          ) : (
            <button type="button" className="ghost big" onClick={() => setCombatMode(false)}>
              ← Back to setup
            </button>
          )}
        </div>
      </header>

      {!combatMode ? (
        <>
          <main className="grid-layout">
            <section className="panel">
              <h2>Add to your team</h2>
              <form onSubmit={handleAddTeam} className="quick-form">
                <input
                  className="grow"
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                  placeholder="Pokémon name (e.g. Infernape)"
                />
                <input
                  className="level-input"
                  type="number"
                  min={1}
                  max={100}
                  value={teamLevel}
                  onChange={(e) => setTeamLevel(e.target.value)}
                  aria-label="Level"
                />
                <select value={teamTarget} onChange={(e) => setTeamTarget(e.target.value as SlotKind)}>
                  <option value="party">Party</option>
                  <option value="backpack">Backpack</option>
                </select>
                <button type="submit" className="primary" disabled={teamLoading}>
                  {teamLoading ? 'Loading…' : 'Add'}
                </button>
              </form>
              {teamSuggestions.length > 0 ? (
                <div className="suggestions">
                  {teamSuggestions.map((name) => (
                    <button
                      key={name}
                      type="button"
                      className="suggestion-chip"
                      onClick={() => setTeamName(prettyName(name))}
                    >
                      {prettyName(name)}
                    </button>
                  ))}
                </div>
              ) : null}
              {teamError ? <p className="hint error">{teamError}</p> : null}
              {teamInfo ? <p className="hint info">{teamInfo}</p> : null}
              <p className="hint">Party holds your main 6; extras go to the backpack.</p>
            </section>

            <section className="panel">
              <h2>Add opponent</h2>
              <form onSubmit={handleAddOpponent} className="quick-form">
                <input
                  className="grow"
                  value={oppName}
                  onChange={(e) => setOppName(e.target.value)}
                  placeholder="Opponent Pokémon (e.g. Garchomp)"
                />
                <input
                  className="level-input"
                  type="number"
                  min={1}
                  max={100}
                  value={oppLevel}
                  onChange={(e) => setOppLevel(e.target.value)}
                  aria-label="Level"
                />
                <button type="submit" className="primary" disabled={oppLoading}>
                  {oppLoading ? 'Loading…' : 'Add'}
                </button>
              </form>
              {oppSuggestions.length > 0 ? (
                <div className="suggestions">
                  {oppSuggestions.map((name) => (
                    <button
                      key={name}
                      type="button"
                      className="suggestion-chip"
                      onClick={() => setOppName(prettyName(name))}
                    >
                      {prettyName(name)}
                    </button>
                  ))}
                </div>
              ) : null}
              {oppError ? <p className="hint error">{oppError}</p> : null}
              {oppInfo ? <p className="hint info">{oppInfo}</p> : null}
              <p className="hint">Log each enemy Pokémon as you scout it.</p>
            </section>
          </main>

          <section className="panel">
            <div className="panel-head">
              <h2>
                Main Party <span className="count">{party.length}/6</span>
              </h2>
              {party.length + backpack.length > 0 ? (
                <button type="button" className="ghost danger" onClick={clearTeam}>
                  Clear team
                </button>
              ) : null}
            </div>
            {party.length === 0 ? (
              <p className="hint">No party Pokémon yet.</p>
            ) : (
              <div className="card-grid">
                {party.map((mon) => (
                  <PokemonCard
                    key={mon.id}
                    pokemon={mon}
                    onRemove={() => setParty((c) => c.filter((e) => e.id !== mon.id))}
                    onMove={() => moveToBackpack(mon.id)}
                    moveLabel="→ Backpack"
                    editable
                    onLevelChange={(level) => changeLevel(mon.id, level)}
                    onSetMove={(slot, slug) => setSlotMove(mon.id, slot, slug)}
                    onRemoveMove={(slot) => removeSlotMove(mon.id, slot)}
                    pendingSlot={pending?.id === mon.id ? pending.slot : null}
                  />
                ))}
              </div>
            )}
          </section>

          {backpack.length > 0 ? (
            <section className="panel">
              <h2>
                Backpack <span className="count">{backpack.length}</span>
              </h2>
              <div className="card-grid">
                {backpack.map((mon) => (
                  <PokemonCard
                    key={mon.id}
                    pokemon={mon}
                    onRemove={() => setBackpack((c) => c.filter((e) => e.id !== mon.id))}
                    onMove={() => moveToParty(mon.id)}
                    moveLabel="→ Party"
                    editable
                    onLevelChange={(level) => changeLevel(mon.id, level)}
                    onSetMove={(slot, slug) => setSlotMove(mon.id, slot, slug)}
                    onRemoveMove={(slot) => removeSlotMove(mon.id, slot)}
                    pendingSlot={pending?.id === mon.id ? pending.slot : null}
                  />
                ))}
              </div>
            </section>
          ) : null}

          <section className="panel">
            <div className="panel-head">
              <h2>
                Opponent Team <span className="count">{opponents.length}</span>
              </h2>
              {opponents.length > 0 ? (
                <button type="button" className="ghost danger" onClick={clearOpponents}>
                  Clear opponents
                </button>
              ) : null}
            </div>
            {opponents.length === 0 ? (
              <p className="hint">No opponents logged yet.</p>
            ) : (
              <div className="card-grid">
                {opponents.map((mon) => (
                  <PokemonCard
                    key={mon.id}
                    pokemon={mon}
                    onRemove={() => setOpponents((c) => c.filter((e) => e.id !== mon.id))}
                  />
                ))}
              </div>
            )}
          </section>
        </>
      ) : (
        <CombatView
          active={active}
          oppActive={oppActive}
          party={party}
          opponents={opponents}
          onSelectActive={setActiveId}
          onSelectOpponent={setOppActiveId}
          advice={advice}
          teamRanking={teamRanking}
        />
      )}
    </div>
  )
}

function MoveRow({ analysis }: { analysis: MoveAnalysis }) {
  const { move } = analysis
  const isStatus = move.category === 'status' || !move.power
  return (
    <>
      <tr className={move.description ? 'has-desc' : ''}>
        <td>
          <strong>{move.name}</strong>
          <div className="move-tags">
            <span className={`type-chip small type-${move.type.toLowerCase()}`}>{move.type}</span>
            {analysis.stab ? <span className="tag">STAB</span> : null}
          </div>
        </td>
        <td className="mono">{isStatus ? 'Status' : `${move.power}`}</td>
        <td className="mono">{move.accuracy ?? '—'}</td>
        <td className={effClass(analysis.effectiveness)}>{effectivenessLabel(analysis.effectiveness)}</td>
        <td className="mono">
          {isStatus ? '—' : `${Math.round(analysis.minPercent)}–${Math.round(analysis.maxPercent)}%`}
        </td>
        <td>
          <span className={`ko ${analysis.ko === 'No damage' ? 'eff-none' : ''}`}>{analysis.ko}</span>
        </td>
      </tr>
      {move.description ? (
        <tr className="desc-row">
          <td colSpan={6}>{move.description}</td>
        </tr>
      ) : null}
    </>
  )
}

function CombatView({
  active,
  oppActive,
  party,
  opponents,
  onSelectActive,
  onSelectOpponent,
  advice,
  teamRanking,
}: {
  active: Pokemon | null
  oppActive: Pokemon | null
  party: Pokemon[]
  opponents: Pokemon[]
  onSelectActive: (id: string) => void
  onSelectOpponent: (id: string) => void
  advice: ReturnType<typeof analyzeBattle> | null
  teamRanking: { name: string; id: string; bestMove: string; percent: number; outspeed: boolean }[]
}) {
  if (!active || !oppActive || !advice) {
    return <p className="hint">Add at least one party Pokémon and one opponent.</p>
  }

  return (
    <div className="combat-wrap">
      <section className="panel battle-selectors">
        <div className="selector">
          <label className="field">
            <span>Your active Pokémon</span>
            <select value={active.id} onChange={(e) => onSelectActive(e.target.value)}>
              {party.map((mon) => (
                <option key={mon.id} value={mon.id}>
                  {mon.name} · Lv {mon.level}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="vs">VS</div>
        <div className="selector">
          <label className="field">
            <span>Opponent active</span>
            <select value={oppActive.id} onChange={(e) => onSelectOpponent(e.target.value)}>
              {opponents.map((mon) => (
                <option key={mon.id} value={mon.id}>
                  {mon.name} · Lv {mon.level}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section className="panel advice-panel">
        <p className="eyebrow">Recommended play</p>
        <h2 className="headline">{advice.headline}</h2>
        <div className="advice-lines">
          <div className="advice-line">
            <span className="advice-label">Speed</span>
            <p>{advice.speedLine}</p>
          </div>
          <div className="advice-line">
            <span className="advice-label">My best move</span>
            <p>{advice.bestMoveLine}</p>
          </div>
          <div className={`advice-line strategy${advice.switchSuggestion ? ' switch' : ''}`}>
            <span className="advice-label">Overall strategy</span>
            <p>{advice.strategyLine}</p>
          </div>
          <div className="advice-line">
            <span className="advice-label">Their best move</span>
            <p>{advice.threatLine}</p>
          </div>
        </div>
      </section>

      <section className="panel">
        <h2>{active.name}&apos;s moves vs {oppActive.name}</h2>
        <div className="table-scroll">
          <table className="move-table">
            <thead>
              <tr>
                <th>Move</th>
                <th>Pow</th>
                <th>Acc</th>
                <th>Matchup</th>
                <th>Damage</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {advice.moves.map((analysis) => (
                <MoveRow key={analysis.move.name} analysis={analysis} />
              ))}
            </tbody>
          </table>
        </div>
        <p className="speed-line">
          Speed: {active.name} {advice.yourSpeed} · {oppActive.name} {advice.opponentSpeed} —{' '}
          {advice.fasterSide === 'you'
            ? 'you move first'
            : advice.fasterSide === 'opponent'
              ? 'they move first'
              : 'speed tie'}
          .
        </p>
      </section>

      <section className="panel">
        <h2>Best answers on your team</h2>
        <div className="results-list">
          {teamRanking.map((entry, index) => (
            <article className="result-card" key={entry.id}>
              <div>
                <h3>
                  {index + 1}. {entry.name} {entry.outspeed ? <span className="tag">outspeeds</span> : null}
                </h3>
                <p className="result-subtitle">Best move: {entry.bestMove}</p>
              </div>
              <span className="score-pill">~{entry.percent}%</span>
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}

export default App
