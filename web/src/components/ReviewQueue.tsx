import { AllCommunityModule, ModuleRegistry, colorSchemeDark, themeQuartz } from 'ag-grid-community';
import type { ColDef, GridApi, GridReadyEvent, RowClassParams } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { Proposal } from '../lib/api';

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
 * Shows the two layers separately. A reviewer needs to know whether the alarm came from
 * a rule that always fires the same way, or from the model reading this one request.
 */
function RiskCell({ data }: { data?: Proposal }) {
  if (!data) return null;
  const { score, ruleScore, modelScore } = data.risk;
  return (
    <span className={`risk ${band(score)}`}>
      <span className="bar">
        <i style={{ width: `${score}%` }} />
      </span>
      <b>{score}</b>
      <small className="split">
        rules {ruleScore}
        {modelScore === undefined ? ' · model off' : ` · model ${modelScore}`}
      </small>
    </span>
  );
}

/**
 * The centrepiece: what the agent said next to what the request actually does. Where the
 * two differ, the reviewer should not have to go looking for it.
 */
function AmountCell({ data }: { data?: Proposal }) {
  if (!data) return null;
  const derived = data.amount
    ? `${data.amount.value.toLocaleString(undefined, { minimumFractionDigits: 2 })} ${data.amount.currency}`
    : null;
  const declared = data.declaredAmount
    ? `${data.declaredAmount.value.toLocaleString(undefined, { minimumFractionDigits: 2 })} ${data.declaredAmount.currency}`
    : null;
  const conflicted = data.mismatches.length > 0;

  return (
    <span className={`amount${conflicted ? ' conflict' : ''}`}>
      <b>{derived ?? 'unverifiable'}</b>
      {declared && declared !== derived && (
        <small>
          agent said {declared}
          {conflicted ? ' ✕' : ''}
        </small>
      )}
      {!derived && !declared && <small>not in the request</small>}
    </span>
  );
}

type Props = {
  proposals: Proposal[];
  selectedId?: string;
  onSelect: (proposal: Proposal) => void;
  onSelectionChange: (ids: string[]) => void;
};

export function ReviewQueue({ proposals, selectedId, onSelect, onSelectionChange }: Props) {
  const columns = useMemo<ColDef<Proposal>[]>(
    () => [
      {
        colId: 'risk',
        headerName: 'Risk',
        width: 168,
        valueGetter: (p) => p.data?.risk.score ?? 0,
        cellRenderer: RiskCell,
        sort: 'desc',
      },
      {
        field: 'status',
        headerName: 'Status',
        width: 108,
        cellRenderer: (p: { value: string }) => <span className={`pill ${p.value}`}>{p.value}</span>,
      },
      { field: 'kind', headerName: 'Action', width: 184, cellClass: 'mono' },
      {
        colId: 'amount',
        headerName: 'Amount in the request',
        width: 198,
        valueGetter: (p) => p.data?.amount?.value ?? null,
        cellRenderer: AmountCell,
      },
      {
        field: 'counterparty',
        headerName: 'Target',
        width: 172,
        cellClass: 'mono',
        valueFormatter: (p) => p.value ?? 'unknown',
      },
      {
        colId: 'why',
        headerName: 'Why Warden decided this',
        flex: 1,
        minWidth: 240,
        valueGetter: (p) => p.data?.policy.reason ?? '',
        tooltip: (p) => String(p.value ?? ''),
      },
      {
        field: 'createdAt',
        headerName: 'Age',
        width: 92,
        valueFormatter: (p) => (p.value ? relativeTime(p.value as string) : ''),
      },
    ],
    [],
  );

  const gridApi = useRef<GridApi<Proposal> | null>(null);

  const rowClass = useCallback(
    (params: RowClassParams<Proposal>) => (params.data?.id === selectedId ? 'row-open' : ''),
    [selectedId],
  );

  // getRowClass is evaluated when a row is drawn, not when React state changes, so the
  // open row would never light up without asking the grid to repaint.
  useEffect(() => {
    gridApi.current?.redrawRows();
  }, [selectedId]);

  return (
    <div className="grid-wrap">
      <AgGridReact<Proposal>
        theme={theme}
        rowData={proposals}
        columnDefs={columns}
        getRowId={(p) => p.data.id}
        onGridReady={(e: GridReadyEvent<Proposal>) => {
          gridApi.current = e.api;
        }}
        rowSelection={{ mode: 'multiRow', headerCheckbox: true, enableClickSelection: false }}
        selectionColumnDef={{ width: 44, pinned: 'left', resizable: false }}
        animateRows
        getRowClass={rowClass}
        onRowClicked={(e) => e.data && onSelect(e.data)}
        onSelectionChanged={(e) => onSelectionChange(e.api.getSelectedRows().map((row) => row.id))}
        defaultColDef={{ sortable: true, filter: true, resizable: true }}
        overlayNoRowsTemplate={'<span style="color:#8b95a3">Nothing in this view.</span>'}
      />
    </div>
  );
}

function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}
