/**
 * PROJECT 13 :: GROUP_CALL_ROOM_REGISTRY
 * Level: Session Layer (Mesh Coordination)
 *
 * In-memory state for active group call rooms.
 * Each room maps to a chat/group and tracks which users are currently in the call.
 */

export type GroupCallParticipant = {
  userId: string
  username: string
  joinedAt: number
  isMuted: boolean
  isVideoOff: boolean
}

const rooms = new Map<string, Map<string, GroupCallParticipant>>()

/** Get all participants in a group call room. */
export function getRoomParticipants(roomId: string): GroupCallParticipant[] {
  const room = rooms.get(roomId)
  if (!room) return []
  return Array.from(room.values())
}

/** Get the user IDs of all participants in a room. */
export function getRoomParticipantIds(roomId: string): string[] {
  const room = rooms.get(roomId)
  if (!room) return []
  return Array.from(room.keys())
}

/** Check if a room has an active call. */
export function isRoomActive(roomId: string): boolean {
  const room = rooms.get(roomId)
  return !!room && room.size > 0
}

/** Check if a user is in a specific room. */
export function isUserInRoom(roomId: string, userId: string): boolean {
  return rooms.get(roomId)?.has(userId) ?? false
}

/** Add a user to a group call room. Returns current participant list (including the new user). */
export function joinRoom(
  roomId: string,
  userId: string,
  username: string
): GroupCallParticipant[] {
  let room = rooms.get(roomId)
  if (!room) {
    room = new Map()
    rooms.set(roomId, room)
  }

  if (!room.has(userId)) {
    room.set(userId, {
      userId,
      username,
      joinedAt: Date.now(),
      isMuted: false,
      isVideoOff: false,
    })
  }

  return Array.from(room.values())
}

/** Remove a user from a group call room. Cleans up empty rooms. Returns remaining participants. */
export function leaveRoom(roomId: string, userId: string): GroupCallParticipant[] {
  const room = rooms.get(roomId)
  if (!room) return []

  room.delete(userId)

  if (room.size === 0) {
    rooms.delete(roomId)
    return []
  }

  return Array.from(room.values())
}

/** Remove a user from ALL rooms they are in. Returns array of [roomId, remainingParticipants]. */
export function leaveAllRooms(userId: string): Array<[string, GroupCallParticipant[]]> {
  const results: Array<[string, GroupCallParticipant[]]> = []

  for (const [roomId, room] of rooms) {
    if (room.has(userId)) {
      room.delete(userId)
      if (room.size === 0) {
        rooms.delete(roomId)
        results.push([roomId, []])
      } else {
        results.push([roomId, Array.from(room.values())])
      }
    }
  }

  return results
}

/** Update mute/video state for a participant. */
export function updateParticipantState(
  roomId: string,
  userId: string,
  patch: { isMuted?: boolean; isVideoOff?: boolean }
): void {
  const room = rooms.get(roomId)
  if (!room) return
  const participant = room.get(userId)
  if (!participant) return

  if (patch.isMuted !== undefined) participant.isMuted = patch.isMuted
  if (patch.isVideoOff !== undefined) participant.isVideoOff = patch.isVideoOff
}

/** Get all active room IDs (for diagnostics). */
export function getActiveRoomIds(): string[] {
  return Array.from(rooms.keys())
}

/** Get participant count for a room. */
export function getRoomSize(roomId: string): number {
  return rooms.get(roomId)?.size ?? 0
}
