// POSIX test fixture: its main thread exits while a worker retains a socket.
#include <arpa/inet.h>
#include <limits.h>
#include <netinet/in.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

static int endpoint;
static const char *token;
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t exited = PTHREAD_COND_INITIALIZER;
static int exit_main;
static pthread_t leader;

static void *serve(void *unused) {
  (void)unused;
  for (;;) {
    int peer = accept(endpoint, NULL, NULL);
    if (peer < 0) _exit(2);
    struct timeval timeout = {.tv_sec = 1};
    if (setsockopt(peer, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) ||
        setsockopt(peer, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout)))
      _exit(2);
    char request[32] = {0};
    size_t size = 0;
    while (size < sizeof(request) - 1) {
      ssize_t received = read(peer, request + size, sizeof(request) - 1 - size);
      if (received <= 0) break;
      size += (size_t)received;
      if (request[size - 1] == '\n') break;
    }
    if (strcmp(request, "exit-main\n") == 0) {
      pthread_mutex_lock(&lock);
      exit_main = 1;
      pthread_cond_signal(&exited);
      pthread_mutex_unlock(&lock);
      if (pthread_join(leader, NULL)) _exit(2);
    }
    if (write(peer, token, strlen(token)) < 0 || write(peer, "\n", 1) < 0)
      _exit(2);
    close(peer);
  }
  return NULL;
}

int main(int argc, char **argv) {
  if (argc != 3) return 2;
  token = argv[2];
  leader = pthread_self();
  endpoint = socket(AF_INET, SOCK_STREAM, 0);
  if (endpoint < 0) return 2;
  struct sockaddr_in address = {
      .sin_family = AF_INET, .sin_addr.s_addr = htonl(INADDR_LOOPBACK)};
  if (bind(endpoint, (struct sockaddr *)&address, sizeof(address)) ||
      listen(endpoint, 4)) return 2;
  socklen_t length = sizeof(address);
  if (getsockname(endpoint, (struct sockaddr *)&address, &length)) return 2;
  pthread_t worker;
  if (pthread_create(&worker, NULL, serve, NULL)) return 2;
  char temporary[PATH_MAX];
  int size = snprintf(temporary, sizeof(temporary), "%s.tmp", argv[1]);
  if (size < 0 || (size_t)size >= sizeof(temporary)) return 2;
  FILE *record = fopen(temporary, "w");
  if (!record) return 2;
  if (fprintf(record, "{\"pid\":%d,\"port\":%d,\"token\":\"%s\"}\n",
              getpid(), ntohs(address.sin_port), token) < 0 || fclose(record) ||
      rename(temporary, argv[1]))
    return 2;
  pthread_mutex_lock(&lock);
  while (!exit_main) pthread_cond_wait(&exited, &lock);
  pthread_mutex_unlock(&lock);
  pthread_exit(NULL);
}
