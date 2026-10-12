/** Keep the native chain running when another file category is still unhandled. */
export function dropFileGroup<P extends { files: File[] }>(props: P, image: boolean, nativeDrop: (props: P) => boolean) {
  const files = props.files.filter(file => file.type.startsWith('image/') === image);
  if (!files.length) return false;
  const handled = nativeDrop({ ...props, files });
  return handled && files.length === props.files.length;
}
