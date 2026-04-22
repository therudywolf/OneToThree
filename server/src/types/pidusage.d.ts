declare module 'pidusage' {
  export default function pidusage(
    pid: number
  ): Promise<{ cpu: number; memory: number; ctime?: number; elapsed?: number; timestamp?: number }>
}
