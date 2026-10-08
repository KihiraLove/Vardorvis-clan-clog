/** Searchable member/participant tables; stable name/ID tie-breakers keep ordering predictable. */
import { useState } from 'react';
import {
  compareXp,
  exactXp,
  skillName,
  type Member,
  type CompetitionDetail,
  type SkillId,
} from './xp-model.ts';
import { XpAmount } from './XpAmount.tsx';

// Source timestamps are presented in UTC consistently across reviewers' local timezones.
export const xpDate = (value: string) =>
  new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(value));
export const xpTime = (value: string) =>
  new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(value)) + ' UTC';

export function MemberTable({
  rows,
  skill,
}: {
  rows: Member[];
  skill: SkillId;
}) {
  const [query, setQuery] = useState(''),
    [sort, setSort] = useState<'xp' | 'name'>('xp');
  const filtered = rows
    .filter((p) => p.displayName.toLowerCase().includes(query.toLowerCase()))
    .sort(
      (a, b) =>
        (sort === 'xp' ? compareXp(a.xp, b.xp) : 0) ||
        a.displayName.localeCompare(b.displayName) ||
        a.playerId - b.playerId,
    );
  return (
    <>
      <div className="xp-table-controls">
        <label>
          Search members
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <span>
          {filtered.length} of {rows.length} members
        </span>
      </div>
      <div className="xp-table-scroll">
        <table className="xp-table">
          <caption className="sr-only">
            {skillName(skill)} cumulative member XP
          </caption>
          <thead>
            <tr>
              <th
                scope="col"
                aria-sort={sort === 'name' ? 'ascending' : 'none'}
              >
                <button onClick={() => setSort('name')}>Member</button>
              </th>
              <th scope="col" aria-sort={sort === 'xp' ? 'descending' : 'none'}>
                <button onClick={() => setSort('xp')}>Recorded XP ↓</button>
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((p) => (
              <tr key={p.playerId}>
                <th scope="row">{p.displayName}</th>
                <td>
                  {p.xp === null ? (
                    <span className="xp-unavailable">Unavailable</span>
                  ) : (
                    <XpAmount
                      xp={p.xp}
                      label={p.displayName + ' ' + skillName(skill)}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!filtered.length && (
        <p className="xp-empty">
          {query
            ? 'No matching members.'
            : 'No recorded member XP for this skill yet.'}
        </p>
      )}
    </>
  );
}
export function ParticipantTable({ detail }: { detail: CompetitionDetail }) {
  const [query, setQuery] = useState(''),
    [sort, setSort] = useState<SkillId | 'name'>(detail.competition.skills[0]!);
  const rows = detail.participants
    .filter((p) => p.displayName.toLowerCase().includes(query.toLowerCase()))
    .sort(
      (a, b) =>
        (sort === 'name'
          ? 0
          : compareXp(a.gains[sort] ?? null, b.gains[sort] ?? null)) ||
        a.displayName.localeCompare(b.displayName) ||
        a.playerId - b.playerId,
    );
  return (
    <>
      <div className="xp-table-controls">
        <label>
          Search competitors
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <span>
          {rows.length} of {detail.participants.length} competitors
        </span>
      </div>
      <div className="xp-table-scroll">
        <table className="xp-table">
          <caption className="sr-only">
            {detail.competition.title} competition gains
          </caption>
          <thead>
            <tr>
              <th
                scope="col"
                aria-sort={sort === 'name' ? 'ascending' : 'none'}
              >
                <button onClick={() => setSort('name')}>Competitor</button>
              </th>
              {detail.competition.skills.map((id) => (
                <th
                  key={id}
                  scope="col"
                  aria-sort={sort === id ? 'descending' : 'none'}
                >
                  <button onClick={() => setSort(id)}>
                    {skillName(id)} XP ↓
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.playerId}>
                <th scope="row">{p.displayName}</th>
                {detail.competition.skills.map((id) => (
                  <td key={id}>
                    {p.gains[id] === null ? (
                      <span className="xp-unavailable">Unavailable</span>
                    ) : (
                      <span tabIndex={0} title={exactXp(p.gains[id]!)}>
                        {exactXp(p.gains[id]!)} XP
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && (
        <p className="xp-empty">
          {query
            ? 'No matching competitors.'
            : 'No competitors in this snapshot.'}
        </p>
      )}
    </>
  );
}
