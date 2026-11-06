/** An email address that may wrap after the "@" instead of being clipped. The text content is unchanged. */
export function EmailText({ value }: { value: string }) {
  const at = value.indexOf("@")
  if (at === -1) return <>{value}</>
  return (
    <>
      {value.slice(0, at + 1)}
      <wbr />
      {value.slice(at + 1)}
    </>
  )
}
