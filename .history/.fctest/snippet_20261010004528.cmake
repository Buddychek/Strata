include(FetchContent)
# CMake 3.30 deprecated FetchContent_Populate(<name>) (policy CMP0169); CMake 4.4 warns every configure.
# The populate-then-add_subdirectory form here is deliberate: ggml is pulled in from the checkout's ggml/
# subdirectory into ${CMAKE_BINARY_DIR}/ggml, the same binary dir the STRATA_GGML_DIR branch uses.
# Pin the old behavior for this call, guarded so CMake < 3.30 (no such policy) still configures.
if(POLICY CMP0169)
  cmake_policy(SET CMP0169 OLD)
endif()
FetchContent_Declare(strata_llamacpp
  GIT_REPOSITORY https://github.com/ggml-org/llama.cpp.git
  GIT_TAG 3cf03257f219afbe7334045ff7c6a06ac68c627d
  GIT_SHALLOW FALSE)
FetchContent_GetProperties(strata_llamacpp)
if(NOT strata_llamacpp_POPULATED)
  FetchContent_Populate(strata_llamacpp)
endif()
message(STATUS "populated: ${strata_llamacpp_POPULATED} src=${strata_llamacpp_SOURCE_DIR}")
