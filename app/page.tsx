import Console from "@/components/Console";
import { loadDataset, provenanceLine } from "@/lib/data";
import { modelLabel } from "@/lib/agent/model";

export const metadata = {
  title: "Runway Alpha — airport investment intelligence",
  description:
    "Ranks US airports on how much profitable capacity a renovation would unlock, from public aviation data.",
};

/**
 * The dataset is handed to the client whole (it is under a megabyte) so the
 * ranking pane can re-score locally when the analyst moves a weight slider.
 * The chat pane still calls the server, because that is where the model and
 * the live FAA feed live.
 */
export default function Page() {
  const ds = loadDataset();
  return (
    <Console
      airports={ds.airports}
      meta={{
        flight_window: ds.meta.flight_window,
        flight_rows: ds.meta.flight_rows,
        caveats: ds.meta.caveats,
      }}
      provenance={provenanceLine(ds)}
      modelLabel={modelLabel()}
    />
  );
}
