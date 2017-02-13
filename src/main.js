import _lt from 'lodash/fp/lt'
import _every from 'lodash/fp/every'
import _cloneDeep from 'lodash/fp/cloneDeep'
import _random from 'lodash/fp/random'

import React from 'react'
import ReactDOM from 'react-dom'

import pressed from 'pressed'
pressed.start()

import config from './config'
import canvasRenderer from './canvasRenderer'
import pieces from './pieces'
import { detectCollision as detectMatrixCollision, getMatrixWidth, removeRowAndShiftRemaining, createEmptyMatrix, combineMatrices } from './matrixUtil'

import store from './store'
import * as score from './stores/score'
import * as lines from './stores/lines'
import * as level from './stores/level'
import * as fallRate from './stores/fallRate'
import * as nextPiece from './stores/nextPiece'
import * as message from './stores/message'
import * as currentPiece from './stores/currentPiece'

import App from './components/App'

const DOWN_KEYS = ['down', 's']
const LEFT_KEYS = ['left', 'a']
const RIGHT_KEYS = ['right', 'd']
const ROTATE_LEFT_KEYS = ['/', 'z']
const ROTATE_RIGHT_KEYS = ['shift']
const START_KEYS = ['enter']

let lateralMovementRate = null // Rate of pieces moving by user control in steps per second
let downMovementRate = null // Rate of pieces moving down by user control in steps per second
let timeSincePieceLastFell = 0 // time since the piece last moved down automatically
let lastFrameTime = 0 // previous frame's current time
let lastRightMove = 0
let lastLeftMove = 0
let lastDownMove = 0
let lastRotate = 0

let board = []
let paused = false
let gameRunning = false

// Automatically pause when window is out of focus
window.onblur = (e) => {
  if (!paused && gameRunning) {
    pauseGame()

    // Unpause when it comes back to focus (but not if the user manually paused)
    window.onfocus = (e) => {
      unpauseGame()
      window.onfocus = null
    }
  }
}

reset()
window.requestAnimationFrame(onFrame)
ReactDOM.render(<App />, document.getElementById('app'))

function onFrame (currentTime) {
  update(currentTime)
  draw()

  window.requestAnimationFrame(onFrame)
}

function reset () {
  store.dispatch(score.resetScore())
  store.dispatch(message.clearMessage())

  timeSincePieceLastFell = 0
  lastFrameTime = 0
  lateralMovementRate = config.lateralMovementRate
  downMovementRate = config.downMovementRate

  const nextRandomPiece = getRandomPiece()
  store.dispatch(nextPiece.setNextPiece(nextRandomPiece))
  store.dispatch(currentPiece.setCurrentPiece(null))
  board = createEmptyMatrix(...config.boardSize)
  const {currentPiece: newCurrentPiece, nextPiece: newNextPiece} = spawnNextAndCurrentPieces()
  store.dispatch(currentPiece.setCurrentPiece(newCurrentPiece))
  store.dispatch(nextPiece.setNextPiece(newNextPiece))

  paused = false
  gameRunning = true
}

function pauseGame () {
  paused = true
  store.dispatch(message.setMessage('Paused'))
}
function unpauseGame () {
  paused = false
  store.dispatch(message.clearMessage())
}

function update (currentTime) {
  let deltaTime = currentTime - lastFrameTime
  lastFrameTime = currentTime

  if (pressed.some(...START_KEYS)) {
    if (gameRunning === false) {
      reset()
    } else {
      paused ? unpauseGame() : pauseGame()
    }
    pressed.remove(...START_KEYS)
  }

  if (gameRunning === false || paused) {
    return
  }

  if (!getCurrentPiece()) {
    const {currentPiece: newCurrentPiece, nextPiece: newNextPiece} = spawnNextAndCurrentPieces()
    store.dispatch(currentPiece.setCurrentPiece(newCurrentPiece))
    store.dispatch(nextPiece.setNextPiece(newNextPiece))
  }

  const lateralMovementThreshold = Math.ceil(1000 / lateralMovementRate)
  const downMovementThreshold = Math.ceil(1000 / downMovementRate)

  // Handle user input...
  if (pressed.some(...DOWN_KEYS)) {
    if (currentTime - lastDownMove > downMovementThreshold) {
      lastDownMove = currentTime

      if (config.instantDown) {
        while (!detectCollisionBelow(board, getCurrentPiece())) {
          makePieceFall(getCurrentPiece())
        }
        pressed.remove(...DOWN_KEYS)
      } else {
        makePieceFall(getCurrentPiece())
      }
    }
  } else {
    lastDownMove = 0
  }

  if (pressed.some(...LEFT_KEYS)) {
    if (currentTime - lastLeftMove > lateralMovementThreshold) {
      lastLeftMove = currentTime

      movePieceLeft(getCurrentPiece())
    }
  } else {
    lastLeftMove = 0
  }

  if (pressed.some(...RIGHT_KEYS)) {
    if (currentTime - lastRightMove > lateralMovementThreshold) {
      lastRightMove = currentTime
      movePieceRight(getCurrentPiece())
    }
  } else {
    lastRightMove = 0
  }

  if (pressed.some(...ROTATE_LEFT_KEYS, ...ROTATE_RIGHT_KEYS)) {
    if (currentTime - lastRotate > lateralMovementThreshold) {
      lastRotate = currentTime
      if (pressed.some(...ROTATE_LEFT_KEYS)) {
        rotatePieceLeft(getCurrentPiece())
      }
      if (pressed.some(...ROTATE_RIGHT_KEYS)) {
        rotatePieceRight(getCurrentPiece())
      }
    }
  } else {
    lastRotate = 0
  }

  timeSincePieceLastFell += deltaTime

  const currentFallRate = fallRate.getFallRate(store.getState())
  const stepThreshold = Math.ceil(1000 / currentFallRate)
  if (timeSincePieceLastFell > stepThreshold) {
    // console.log('tick')
    makePieceFall(getCurrentPiece())
  }

  if (detectCollision(board, getCurrentPiece())) {
    // console.log('Collision detected!')

    // This bit of foo allows you to shift the piece around a bit and only
    // detects collisions at the end of the step instead of at the beginning.
    const previousPositionPiece = _cloneDeep(getCurrentPiece())
    previousPositionPiece.y -= 1
    board = resolveCollision(board, previousPositionPiece)

    const {currentPiece: newCurrentPiece, nextPiece: newNextPiece} = spawnNextAndCurrentPieces()
    store.dispatch(currentPiece.setCurrentPiece(newCurrentPiece))
    store.dispatch(nextPiece.setNextPiece(newNextPiece))

    const currentLevel = level.getLevel(store.getState())
    store.dispatch(score.addPieceScore(currentLevel))

    // If there is still a collision right after a new piece is spawned, the game ends.
    if (detectCollision(board, getCurrentPiece())) {
      console.error('Game over! Press ENTER to restart.')
      store.dispatch(message.setMessage('Game Over!'))
      gameRunning = false
    }
  }

  board = clearCompletedLines(board)
}

const getCurrentPiece = () => currentPiece.getCurrentPiece(store.getState())

function makePieceFall (piece) {
  timeSincePieceLastFell = 0
  piece.y += 1
}

function spawnNextAndCurrentPieces () {
  const [W] = config.boardSize
  const newCurrentPiece = clonePiece(nextPiece.getNextPiece(store.getState()))
  newCurrentPiece.x = Math.floor((W - newCurrentPiece.matrix[0].length) / 2)

  const randomNextPiece = getRandomPiece()

  return {currentPiece: newCurrentPiece, nextPiece: randomNextPiece}
}

function clonePiece (piece) {
  let clonedPiece = _cloneDeep(piece)
  clonedPiece.x = clonedPiece.x || 0
  clonedPiece.y = clonedPiece.y || 0
  return clonedPiece
}

function getRandomPiece () {
  const l = pieces.length
  const i = _random(0, l - 1)
  return pieces[i]
}

function movePieceLeft (piece) {
  piece.x -= 1
  if (detectCollision(board, piece)) { piece.x += 1 }
}

function movePieceRight (piece) {
  piece.x += 1
  if (detectCollision(board, piece)) { piece.x -= 1 }
}

function rotatePieceRight (piece) {
  const matrixBeforeRotation = piece.matrix
  store.dispatch(currentPiece.rotateRight())
  const rotatedPiece = getCurrentPiece()
  const x = validateRotation(board, rotatedPiece, matrixBeforeRotation)
  store.dispatch(currentPiece.setX(x))
}

function rotatePieceLeft (piece) {
  const matrixBeforeRotation = piece.matrix
  store.dispatch(currentPiece.rotateLeft())
  const rotatedPiece = getCurrentPiece()
  const x = validateRotation(board, rotatedPiece, matrixBeforeRotation)
  store.dispatch(currentPiece.setX(x))
}

function validateRotation (board, piece, originalMatrix) {
  piece = _cloneDeep(piece)
  let originalX = piece.x
  let pieceWidth = getMatrixWidth(piece.matrix)
  let offsetX = 1

  while (detectCollision(board, piece)) {
    piece.x += offsetX

    // flip direction and add one square after trying left and right
    if (offsetX > 0) {
      offsetX = -offsetX
    } else {
      offsetX = -offsetX + 1
    }

    if (Math.abs(offsetX) > Math.ceil(pieceWidth / 2)) {
      return originalX
    }
  }
  return piece.x
}

function detectCollision (board, {x, y, matrix: pieceMatrix}) {
  return detectMatrixCollision(board, pieceMatrix, x, y)
}

function detectCollisionBelow (board, {x, y, matrix: pieceMatrix}) {
  return detectMatrixCollision(board, pieceMatrix, x, y + 1)
}

function resolveCollision (board, {matrix: pieceMatrix, x, y}) {
  return combineMatrices(board, pieceMatrix, x, y, false)
}

function clearCompletedLines (board) {
  let fullRows = board.reduce((fullRows, row, rowIndex, board) => {
    if (_every(_lt(0))(row)) {
      fullRows.push(rowIndex)
    }
    return fullRows
  }, [])

  if (fullRows.length) {
    const clearedLines = fullRows.length
    const currentLevel = level.getLevel(store.getState())
    store.dispatch(score.addClearedLineScore(clearedLines, currentLevel))
    store.dispatch(lines.incrementLines(clearedLines))
  }

  return fullRows.reduce((board, rowIndex) => removeRowAndShiftRemaining(board, rowIndex), board)
}

function draw () {
  canvasRenderer.drawGame(board, getCurrentPiece())
}
