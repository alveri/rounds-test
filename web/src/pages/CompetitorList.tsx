import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../api';

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function CompetitorList() {
  const queryClient = useQueryClient();
  const [id, setId] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmingRemoval, setConfirmingRemoval] = useState<string | null>(null);

  const competitors = useQuery({
    queryKey: ['competitors'],
    queryFn: api.listCompetitors,
    refetchInterval: 10_000, // picks up lastPolledAt / lastPollError
  });

  const add = useMutation({
    mutationFn: api.addCompetitor,
    onSuccess: () => {
      setId('');
      setFormError(null);
      return queryClient.invalidateQueries({ queryKey: ['competitors'] });
    },
    onError: (err, submittedId) =>
      setFormError(
        err instanceof ApiError && err.status === 409 ? `"${submittedId}" is already tracked.` : err.message,
      ),
  });

  const remove = useMutation({
    mutationFn: api.removeCompetitor,
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['competitors'] }),
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const value = id.trim();
    if (!ID_PATTERN.test(value)) {
      setFormError('Use lowercase letters, digits and dashes, e.g. acme-crm.');
      return;
    }
    add.mutate(value);
  }

  return (
    <section>
      <form onSubmit={onSubmit} className="add-form">
        <input
          aria-label="Competitor id"
          placeholder="competitor id, e.g. acme-crm"
          value={id}
          onChange={(e) => {
            setId(e.target.value);
            setFormError(null);
          }}
          autoFocus
        />
        <button type="submit" disabled={add.isPending}>
          {add.isPending ? 'Tracking…' : 'Track'}
        </button>
      </form>
      {formError && (
        <p role="alert" className="error">
          {formError}
        </p>
      )}

      {competitors.isPending && <p className="muted">Loading…</p>}
      {competitors.isError && (
        <p role="alert" className="error">
          Could not load competitors: {competitors.error.message}
        </p>
      )}
      {competitors.data?.length === 0 && (
        <p className="muted">No competitors tracked yet. Try acme-crm, north-analytics or ferry-pay.</p>
      )}

      <ul className="competitors">
        {competitors.data?.map((c) => (
          <li key={c.id}>
            <div>
              <Link to={`/competitors/${encodeURIComponent(c.id)}`}>{c.id}</Link>
              <div className="muted small">
                {c.lastPolledAt ? `Last checked ${new Date(c.lastPolledAt).toLocaleString()}` : 'Not checked yet'}
              </div>
              {c.lastPollError && <div className="error small">Last check failed: {c.lastPollError}</div>}
            </div>
            {confirmingRemoval === c.id ? (
              <div className="toolbar">
                <button
                  type="button"
                  onClick={() => {
                    setConfirmingRemoval(null);
                    remove.mutate(c.id);
                  }}
                >
                  Delete with history
                </button>
                <button type="button" onClick={() => setConfirmingRemoval(null)}>
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmingRemoval(c.id)}
                disabled={remove.isPending && remove.variables === c.id}
              >
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      {remove.isError && (
        <p role="alert" className="error">
          Could not remove: {remove.error.message}
        </p>
      )}
    </section>
  );
}
