/**
 * The account a password form is for, as a read-only, visually hidden field: password managers
 * then know which login to fill or update, and browsers stop warning about password forms with
 * no username. Screen readers still read its label; it is skipped by the tab key.
 */
export function UsernameField(props: { username: string }) {
  return (
    <label className="visually-hidden">
      Username
      <input
        type="text"
        name="username"
        autoComplete="username"
        value={props.username}
        readOnly
        tabIndex={-1}
      />
    </label>
  )
}
