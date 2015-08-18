import generalCommands from './general';
import contextCommands from './context';

let commands = {};

Object.assign(commands, generalCommands, contextCommands);

export default commands;
