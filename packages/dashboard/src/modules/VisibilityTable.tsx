/**
 * Static reference panel: what the chain reveals vs what it hides.
 * Same content as the campaign messaging — defuses skepticism by being honest.
 */
export function VisibilityTable() {
  return (
    <div data-strk20-card="visibility-table">
      <div data-strk20-label>What's visible · what's hidden</div>
      <table data-strk20-visibility>
        <thead>
          <tr>
            <th>Action</th>
            <th>Address</th>
            <th>Amount</th>
            <th>Asset</th>
            <th>Linkable</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Deposit</td>
            <td className="yes">visible</td>
            <td className="yes">visible</td>
            <td className="yes">visible</td>
            <td>—</td>
          </tr>
          <tr>
            <td>Private operation inside pool</td>
            <td className="no">hidden</td>
            <td className="no">hidden</td>
            <td className="no">hidden</td>
            <td className="no">unlinkable</td>
          </tr>
          <tr>
            <td>Withdrawal (source)</td>
            <td className="no">hidden</td>
            <td>—</td>
            <td>—</td>
            <td className="no">unlinkable to deposit</td>
          </tr>
          <tr>
            <td>Withdrawal (destination)</td>
            <td className="yes">visible</td>
            <td className="yes">visible</td>
            <td className="yes">visible</td>
            <td>—</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
