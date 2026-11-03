import { AllCommunityModule, ModuleRegistry, colorSchemeDark, themeQuartz } from 'ag-grid-community';
import type {
  ColDef,
  GridApi,
  GridReadyEvent,
  GridState,
  IRowNode,
  PostSortRowsParams,
  RowClassParams,
  RowHeightParams,
} from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, type AuditEntry, type Proposal } from '../lib/api';

ModuleRegistry.registerModules([AllCommunityModule]);

const theme = themeQuartz.withPart(colorSchemeDark).withParams({
  backgroundColor: '#0b0d10',
  foregroundColor: '#e6eaef',
  borderColor: '#242c35',
  headerBackgroundColor: '#12161b',
  headerTextColor: '#8b95a3',
  oddRowBackgroundColor: '#0e1115',
  rowHoverColor: '#171c23',
  selectedRowBackgroundColor: '#13203a',
  accentColor: '#4c8dff',
  fontFamily: 'inherit',
  headerFontSize: 11,
  rowHeight: 64,
});

function band(score: number): 'low' | 'med' | 'high' {
  if (score >= 70) return 'high';
  if (score >= 40) return 'med';
  return 'low';
}

/**
 * The queue holds three kinds of row. Only the first is a proposal; the other two exist so
 * the grid can draw an audit chain underneath a row and a summary under the whole view
 * without a second table beside it.
 */
type DetailRow = { id: string; detailFor: string };
type TotalsRow = { id: 'totals'; totals: { count: number; sum: number; currency: string } };
type Row = Proposal | DetailRow | TotalsRow;

const isDetail = (row?: Row | null): row is DetailRow => !!row && 'detailFor' in row;
const isTotals = (row?: Row | null): row is TotalsRow => !!row && 'totals' in row;
const isProposal = (row?: Row | null): row is Proposal => !!row && 'risk' in row;

/**
 * Shows the two layers separately. A reviewer needs to know whether the alarm came from
 * a rule that always fires the same way, or from the model reading this one request.
 */
function RiskCell({ data }: { data?: Row }) {
  if (isTotals(data)) return <span className="totals-label">Filtered view</span>;
  if (!isProposal(data)) return null;
  const { score, ruleScore, modelScore } = data.risk;
  // The split is worth a line only when the two layers can disagree. Where the model did
  // not run, "model off" was true on every row at once, which is a property of the
  // deployment and is stated once above the grid instead.
  const split = modelScore === undefined ? undefined : `rules ${ruleScore} \u00b7 model ${modelScore}`;
  return (
    <span className={`risk ${band(score)}`} title={split ?? `rules ${ruleScore}, model did not run`}>
      <span className="bar">
        <i style={{ width: `${score}%` }} />
      </span>
      <b>{score}</b>
      {split && <small className="split">{split}</small>}
    </span>
  );
}

/**
 * The centrepiece: what the agent said next to what the request actually does. Where the
 * two differ, the reviewer should not have to go looking for it.
 */
const amountText = (m?: { value: number; currency: string }) =>
  m ? `${m.value.toLocaleString(undefined, { minimumFractionDigits: 2 })} ${m.currency}` : null;

/**
 * The figure a reviewer acts on, and where it came from. The request binds where it
 * speaks; where it is silent, PayPal's own record does; the agent's claim is shown only
 * so the reviewer can see when it disagrees with either.
 */
function AmountCell({ data }: { data?: Row }) {
  if (isTotals(data))
    return (
      <span className="amount">
        <b>{amountText({ value: data.totals.sum, currency: data.totals.currency })}</b>
        <small>at stake in this view</small>
      </span>
    );
  if (!isProposal(data)) return null;
  const derived = amountText(data.amount);
  const declared = amountText(data.declaredAmount);
  const fromPayPal = amountText(data.verification.amount);
  const contradicted = data.verification.status === 'contradicted';
  const conflicted = data.mismatches.length > 0 || contradicted;

  // At most one line of provenance, in the order that matters to a reviewer:
  // PayPal disagreeing, then PayPal supplying what the request lacked, then the
  // agent's claim where it differs from the request.
  let note: string | undefined;
  // When the figures agree, the contradiction is about the resource's state (an invoice
  // still in DRAFT, say): show that, not an amount that looks equal to the request's
  if (contradicted) note = `PayPal: ${fromPayPal && fromPayPal !== derived ? fromPayPal : (data.verification.resourceState ?? 'disagrees')} ✕`;
  // A lookup that was attempted and failed matters even when the request carries a
  // figure: that figure is a ceiling, not proof there is anything left to refund.
  else if (data.verification.status === 'unavailable') note = 'PayPal could not confirm';
  else if (!derived && fromPayPal) note = "PayPal's figure, not the agent's";
  else if (declared && declared !== derived) note = `agent said ${declared}${conflicted ? ' ✕' : ''}`;
  else if (!derived) note = 'not in the request';

  return (
    <span
      className={`amount${conflicted ? ' conflict' : ''}${data.verification.status === 'unavailable' ? ' unconfirmed' : ''}`}
    >
      <b>{derived ?? fromPayPal ?? 'unverifiable'}</b>
      {note && <small>{note}</small>}
    </span>
  );
}

/**
 * The audit chain for one proposal, drawn as a full-width row under it. Every entry
 * carries the hash of the one before, so the point of showing them in order is that a
 * reviewer can see the links as well as the events.
 */
function AuditChainRow({ data, entries }: { data: DetailRow; entries?: AuditEntry[] }) {
  const mine = entries?.filter((entry) => entry.proposalId === data.detailFor);
  if (!entries) return <div className="chain loading">Reading the audit log…</div>;
  if (!mine?.length)
    return <div className="chain loading">No audit entries carry this proposal's id.</div>;
  return (
    <div className="chain">
      <header>
        Audit chain · {mine.length} {mine.length === 1 ? 'entry' : 'entries'}
      </header>
      <ol>
        {mine.map((entry) => (
          <li key={entry.seq}>
            <b className="mono">#{entry.seq}</b>
            <span className="chain-type">{entry.type}</span>
            <span className="chain-actor mono">{entry.actor}</span>
            <time>{new Date(entry.ts).toLocaleString()}</time>
            <code title={`prev ${entry.prevHash}`}>{entry.hash.slice(0, 16)}…</code>
          </li>
        ))}
      </ol>
    </div>
  );
}

type Props = {
  /** The status chips and bulk actions, which belong to the page rather than the grid.
   *  They render inside the grid's own toolbar so there is one row of controls, not two. */
  leading?: ReactNode;
  /** Page-level actions that belong on the right of the same row, beside the export. */
  trailing?: ReactNode;
  /** Set when the seeded queue was scored without the model, which is a property of the
   *  deployment rather than of any one row: said once here, not on all fourteen. */
  modelOff?: boolean;
  proposals: Proposal[];
  selectedId?: string;
  onSelect: (proposal: Proposal) => void;
  onSelectionChange: (ids: string[]) => void;
};

const BANDS = [
  { key: 'all', label: 'All risk' },
  { key: 'high', label: '70+' },
  { key: 'med', label: '40–69' },
  { key: 'low', label: 'under 40' },
] as const;
type BandKey = (typeof BANDS)[number]['key'];

// v2: a saved state carries column visibility and widths, so a reviewer who had seen the
// old layout would keep the truncated Why column and the wide Target. Bumping the key
// hands everyone the new defaults once, and their own adjustments survive from there.
const STATE_KEY = 'interlock.queue.gridstate.v2';

export function ReviewQueue({ leading, trailing, modelOff, proposals, selectedId, onSelect, onSelectionChange }: Props) {
  const [query, setQuery] = useState('');
  const [bandFilter, setBandFilter] = useState<BandKey>('all');
  const [expandedId, setExpandedId] = useState<string>();
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>();
  const [totals, setTotals] = useState<TotalsRow['totals']>({ count: 0, sum: 0, currency: 'USD' });

  const gridApi = useRef<GridApi<Row> | null>(null);

  // The chain is only worth a request once the reviewer asks for it, and one request
  // answers for every row: the log is a single ordered list, not a per-proposal resource.
  useEffect(() => {
    if (!expandedId || auditEntries) return;
    let cancelled = false;
    void api
      .audit(300)
      .then((entries) => {
        if (!cancelled) setAuditEntries(entries);
      })
      .catch(() => {
        if (!cancelled) setAuditEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [expandedId, auditEntries]);

  const rowData = useMemo<Row[]>(() => {
    const rows: Row[] = [];
    for (const proposal of proposals) {
      rows.push(proposal);
      if (proposal.id === expandedId) rows.push({ id: `detail:${proposal.id}`, detailFor: proposal.id });
    }
    return rows;
  }, [proposals, expandedId]);

  const columns = useMemo<ColDef<Row>[]>(
    () => [
      {
        colId: 'expand',
        headerName: '',
        width: 40,
        pinned: 'left',
        resizable: false,
        sortable: false,
        filter: false,
        suppressCsvExport: true,
        cellClass: 'expand-cell',
        cellRenderer: (p: { data?: Row }) => {
          if (!isProposal(p.data)) return null;
          const id = p.data.id;
          const open = id === expandedId;
          return (
            <button
              type="button"
              className={`chev${open ? ' open' : ''}`}
              title={open ? 'Hide the audit chain' : 'Show the audit chain'}
              onClick={(event) => {
                // The row underneath opens the proposal; the chevron must not do both.
                // This alone does not stop it -- the grid's own row listener sits below
                // React's root -- so onRowClicked checks the target as well.
                event.stopPropagation();
                setExpandedId(open ? undefined : id);
              }}
            >
              ›
            </button>
          );
        },
      },
      {
        colId: 'risk',
        headerName: 'Risk',
        width: 168,
        valueGetter: (p) => (isProposal(p.data) ? p.data.risk.score : null),
        cellRenderer: RiskCell,
        filter: 'agNumberColumnFilter',
        // The score moves when a re-run changes the model's half of it, and a number that
        // changed quietly is worse than no number.
        enableCellChangeFlash: true,
        sort: 'desc',
      },
      {
        colId: 'status',
        headerName: 'Status',
        width: 108,
        valueGetter: (p) => (isProposal(p.data) ? p.data.status : null),
        filter: 'agTextColumnFilter',
        enableCellChangeFlash: true,
        cellRenderer: (p: { value?: string; data?: Row }) => {
          if (isTotals(p.data)) return <span className="totals-count">{p.data.totals.count} shown</span>;
          return p.value ? <span className={`pill ${p.value}`}>{p.value}</span> : null;
        },
      },
      {
        colId: 'kind',
        headerName: 'Action',
        flex: 1,
        minWidth: 184,
        cellClass: 'mono',
        filter: 'agTextColumnFilter',
        valueGetter: (p) => (isProposal(p.data) ? p.data.kind : null),
      },
      {
        colId: 'amount',
        headerName: 'Amount',
        headerTooltip:
          "What the decision rests on: the amount read from the request, or PayPal's own where the request was silent.",
        width: 198,
        valueGetter: (p) =>
          isProposal(p.data) ? (p.data.amount?.value ?? p.data.verification.amount?.value ?? null) : null,
        cellRenderer: AmountCell,
        filter: 'agNumberColumnFilter',
      },
      {
        colId: 'counterparty',
        headerName: 'Target',
        width: 124,
        tooltipValueGetter: (p) => String(p.value ?? ''),
        cellClass: 'mono',
        filter: 'agTextColumnFilter',
        valueGetter: (p) => (isProposal(p.data) ? (p.data.counterparty ?? 'unknown') : null),
      },
      {
        colId: 'why',
        headerName: 'Why Interlock decided this',
        // Hidden, not removed: at 240px it truncated on every row and five rows in a row
        // read the same rule name, which the Risk column already says. The reviewer reads
        // it in full in the panel; the CSV still exports it by column id.
        hide: true,
        minWidth: 240,
        filter: 'agTextColumnFilter',
        valueGetter: (p) => (isProposal(p.data) ? p.data.policy.reason : ''),
        tooltipValueGetter: (p) => String(p.value ?? ''),
      },
      {
        colId: 'createdAt',
        headerName: 'Age',
        width: 92,
        filter: false,
        valueGetter: (p) => (isProposal(p.data) ? p.data.createdAt : null),
        valueFormatter: (p) => (p.value ? relativeTime(p.value as string) : ''),
      },
    ],
    [expandedId],
  );

  const rowClass = useCallback(
    (params: RowClassParams<Row>) => {
      if (isDetail(params.data)) return 'row-detail';
      return isProposal(params.data) && params.data.id === selectedId ? 'row-open' : '';
    },
    [selectedId],
  );

  // getRowClass is evaluated when a row is drawn, not when React state changes, so the
  // open row would never light up without asking the grid to repaint.
  useEffect(() => {
    gridApi.current?.redrawRows();
  }, [selectedId]);

  // The band chips sit outside the column filters, so the grid has to be told its filter
  // state changed; it cannot see React state.
  useEffect(() => {
    gridApi.current?.onFilterChanged();
  }, [bandFilter]);

  const recountTotals = useCallback(() => {
    const grid = gridApi.current;
    if (!grid) return;
    let count = 0;
    let sum = 0;
    let currency = 'USD';
    grid.forEachNodeAfterFilter((node: IRowNode<Row>) => {
      const row = node.data;
      if (!isProposal(row)) return;
      count += 1;
      const money = row.amount ?? row.verification.amount;
      if (money) {
        sum += money.value;
        currency = money.currency;
      }
    });
    setTotals({ count, sum, currency });
  }, []);

  const pinnedBottom = useMemo<TotalsRow[]>(() => [{ id: 'totals', totals }], [totals]);

  // Row heights are cached, and the chain's height is only known once the audit log
  // has been read, so the first detail row opened at its empty-state height.
  useEffect(() => {
    if (auditEntries) gridApi.current?.resetRowHeights();
  }, [auditEntries]);

  // Replacing pinnedBottomRowData puts the new figures on the row node, but the grid
  // keeps the cells it already rendered, so the footer stayed on its starting zeroes.
  // Force the one row to redraw once the totals change.
  useEffect(() => {
    const node = gridApi.current?.getPinnedBottomRow(0);
    if (node) gridApi.current?.refreshCells({ rowNodes: [node], force: true });
  }, [totals]);

  return (
    <>
      <div className="grid-tools">
        {leading}
        <input
          className="quick-filter"
          type="search"
          value={query}
          placeholder="Search every column…"
          aria-label="Search the queue"
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="chips" role="group" aria-label="Filter by risk score">
          {BANDS.map((option) => (
            <button
              key={option.key}
              type="button"
              className={`chip${bandFilter === option.key ? ' on' : ''}`}
              onClick={() => setBandFilter(option.key)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <span className="spacer" />
        {modelOff && (
          <span className="tool-note" title="INTERLOCK_SEED_MODEL is off on the public demo, so the queue it boots with costs no model calls. Anything an agent files after boot is scored by the model.">
            seeded queue scored by rules
          </span>
        )}
        {trailing}
        <button
          type="button"
          onClick={() =>
            gridApi.current?.exportDataAsCsv({
              fileName: `interlock-queue-${new Date().toISOString().slice(0, 10)}.csv`,
              // A detail row has no cells, and the totals row is a summary of the export
              // rather than a row of it.
              shouldRowBeSkipped: (params) => !isProposal(params.node.data),
              // Naming the columns drops the selection checkbox and the chevron, which
              // carry no value and exported as two empty leading columns.
              columnKeys: ['risk', 'status', 'kind', 'amount', 'counterparty', 'why', 'createdAt'],
            })
          }
        >
          Export CSV
        </button>
      </div>
      <div className="grid-wrap">
        <AgGridReact<Row>
          theme={theme}
          rowData={rowData}
          columnDefs={columns}
          getRowId={(p) => p.data.id}
          quickFilterText={query}
          // Column widths, sort and filters are a reviewer's own setup; losing them on
          // every reload is the kind of small insult that stops people using a tool.
          initialState={readSavedState()}
          onStateUpdated={(event) => {
            try {
              localStorage.setItem(STATE_KEY, JSON.stringify(event.state));
            } catch {
              // A browser with storage denied still gets a working grid.
            }
          }}
          onGridReady={(e: GridReadyEvent<Row>) => {
            gridApi.current = e.api;
            recountTotals();
          }}
          isExternalFilterPresent={() => bandFilter !== 'all'}
          doesExternalFilterPass={(node: IRowNode<Row>) => {
            const row = node.data;
            // A detail row belongs to the proposal above it and must leave with it.
            if (isDetail(row)) {
              const parent = proposals.find((p) => p.id === row.detailFor);
              return !!parent && band(parent.risk.score) === bandFilter;
            }
            if (!isProposal(row)) return true;
            return band(row.risk.score) === bandFilter;
          }}
          isFullWidthRow={(p) => isDetail(p.rowNode.data)}
          fullWidthCellRenderer={(p: { data: DetailRow }) => (
            <AuditChainRow data={p.data} entries={auditEntries} />
          )}
          // A detail row is as tall as its chain, not a fixed block: most proposals carry
          // one or two entries, and a fixed height left an empty panel under them.
          getRowHeight={(p: RowHeightParams<Row>) => {
            const row = p.data;
            if (!isDetail(row)) return undefined;
            const mine = auditEntries?.filter((entry) => entry.proposalId === row.detailFor).length;
            if (!mine) return 56;
            return 46 + Math.min(mine, 8) * 23;
          }}
          pinnedBottomRowData={pinnedBottom}
          rowSelection={{
            mode: 'multiRow',
            headerCheckbox: true,
            enableClickSelection: false,
            isRowSelectable: (node) => isProposal(node.data),
          }}
          selectionColumnDef={{ width: 44, pinned: 'left', resizable: false }}
          animateRows
          getRowClass={rowClass}
          // Sorting is free to put the rows in any order, and a detail row has no risk
          // or amount to sort on, so it drifted to the bottom of the table. Put each one
          // back under the proposal it belongs to once the sort has run.
          postSortRows={(params: PostSortRowsParams<Row>) => {
            const nodes = params.nodes;
            for (let i = nodes.length - 1; i >= 0; i--) {
              const row = nodes[i]?.data;
              if (!isDetail(row)) continue;
              const [node] = nodes.splice(i, 1);
              if (!node) continue;
              const parent = nodes.findIndex((n) => isProposal(n.data) && n.data.id === row.detailFor);
              nodes.splice(parent >= 0 ? parent + 1 : nodes.length, 0, node);
            }
          }}
          onRowClicked={(e) => {
            // AG Grid listens for the click on the row element itself, below React's
            // root, so the chevron's stopPropagation never reaches this. Read the
            // target instead: a click on the chevron expands and nothing else.
            const target = e.event?.target as HTMLElement | undefined;
            if (target?.closest('.expand-cell')) return;
            if (isProposal(e.data)) onSelect(e.data);
          }}
          onSelectionChanged={(e) =>
            onSelectionChange(e.api.getSelectedRows().filter(isProposal).map((row) => row.id))
          }
          onFilterChanged={recountTotals}
          onModelUpdated={recountTotals}
          defaultColDef={{ sortable: true, filter: true, resizable: true }}
          overlayNoRowsTemplate={'<span style="color:#8b95a3">Nothing in this view.</span>'}
          // overlayNoRowsTemplate covers an empty queue; a queue filtered down to nothing
          // is a separate overlay with its own wording, which defaulted to AG Grid's.
          localeText={{ noMatchingRows: 'Nothing matches these filters.' }}
        />
      </div>
    </>
  );
}

function readSavedState(): GridState | undefined {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    return raw ? (JSON.parse(raw) as GridState) : undefined;
  } catch {
    return undefined;
  }
}

function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}
