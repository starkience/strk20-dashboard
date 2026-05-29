import { useApi } from "../lib/use-api.js";
import { Row } from "../lib/Row.js";
import { Disclosure } from "../lib/Disclosure.js";

export interface NoteAgeHistogramData {
  fresh: number;
  young: number;
  mature: number;
  veteran: number;
}

export interface NoteAgeHistogramProps {
  data?: NoteAgeHistogramData;
}

export function useNoteAgeHistogramData(): NoteAgeHistogramData | null {
  return useApi<NoteAgeHistogramData>("/agg/note-ages", { pollMs: 30_000 }).data;
}

const TIERS = [
  { key: "fresh", label: "Fresh", hint: "< 1h" },
  { key: "young", label: "Young", hint: "1h–1d" },
  { key: "mature", label: "Mature", hint: "1d–7d" },
  { key: "veteran", label: "Veteran", hint: "> 7d" },
] as const;

export function NoteAgeHistogram({ data: dataProp }: NoteAgeHistogramProps = {}) {
  const fetched = useNoteAgeHistogramData();
  const data = dataProp ?? fetched;
  const total = data ? data.fresh + data.young + data.mature + data.veteran : 0;
  return (
    <Disclosure label="Note ages" summary={data ? `${total.toLocaleString()}` : "—"}>
      {TIERS.map((t) => (
        <Row
          key={t.key}
          label={t.label}
          context={t.hint}
          value={data ? data[t.key].toLocaleString() : "—"}
        />
      ))}
    </Disclosure>
  );
}
