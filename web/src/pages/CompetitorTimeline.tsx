import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { api, ApiError, isWorthRefetching, nextSnapshotCursor, type Snapshot } from '../api';

export function CompetitorTimeline() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();

  const snapshots = useInfiniteQuery({
    queryKey: ['snapshots', id],
    queryFn: ({ pageParam }) => api.listSnapshots(id, pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: nextSnapshotCursor,
    // New snapshots and pending summaries show up without a manual reload.
    refetchInterval: (query) => (isWorthRefetching(query.state.error) ? 5_000 : false),
  });
  const rows = snapshots.data?.pages.flat();

  const pollNow = useMutation({
    mutationFn: () => api.pollNow(id),
    onSuccess: () =>
      setTimeout(() => void queryClient.invalidateQueries({ queryKey: ['snapshots', id] }), 1_500),
  });

  return (
    <section>
      <div className="toolbar">
        <Link to="/" className="button">
          ← Back to competitors
        </Link>
        <button type="button" onClick={() => pollNow.mutate()} disabled={pollNow.isPending || !isWorthRefetching(snapshots.error)}>
          Check now
        </button>
      </div>
      <h2>{id}</h2>

      {snapshots.isPending && <p className="muted">Loading…</p>}
      {snapshots.isError && (
        <p role="alert" className="error">
          {snapshots.error instanceof ApiError && snapshots.error.status === 404
            ? `"${id}" is not tracked.`
            : `Could not load snapshots: ${snapshots.error.message}`}
        </p>
      )}
      {rows?.length === 0 && (
        <p className="muted">No snapshots yet. The first check runs within a few seconds of adding.</p>
      )}

      <ol className="timeline">
        {rows?.map((s) => (
          <li key={s.id} className="snapshot">
            <time dateTime={s.fetchedAt} className="muted small">
              {new Date(s.fetchedAt).toLocaleString()}
            </time>
            <div>
              <strong>{s.title}</strong> — {s.tagline}
            </div>
            <div>{s.price}</div>
            <div>{s.description}</div>
            <SummaryLine snapshot={s} />
          </li>
        ))}
      </ol>
      {snapshots.hasNextPage && (
        <button type="button" onClick={() => void snapshots.fetchNextPage()} disabled={snapshots.isFetchingNextPage}>
          {snapshots.isFetchingNextPage ? 'Loading…' : 'Load older snapshots'}
        </button>
      )}
    </section>
  );
}

/** Exactly one caption per snapshot. Listing text and summaries are rendered as text. */
function SummaryLine({ snapshot }: { snapshot: Snapshot }) {
  if (snapshot.initial) return <p className="muted">Initial snapshot.</p>;
  if (!snapshot.changed) return <p className="muted">No change since previous snapshot.</p>;
  switch (snapshot.summaryStatus) {
    case 'ready':
      return <p className="summary">{snapshot.summary}</p>;
    case 'pending':
      return <p className="muted">Changed. Summary pending…</p>;
    case 'failed':
      return <p className="muted">Changed. Summary unavailable (the AI summary could not be generated).</p>;
    case 'none':
      return <p className="muted">Changed.</p>;
  }
}
